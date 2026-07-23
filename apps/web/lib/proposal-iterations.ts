import {
  appVersions,
  auditLog,
  type Database,
  runs,
  workspaceArtifacts,
  type WorkspaceArtifact,
} from "@ai-workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDraftVersionSummary } from "@/lib/app-draft-versions";
import {
  outputProposalFromMetadata,
  releaseOutputProposalIterationMetadata,
  supersedeOutputProposalMetadata,
  type OutputProposalContext,
  type OutputProposalIterationLineage,
  type ProposalIterationTarget,
  type UnattendedOutputTriggerType,
} from "@/lib/output-proposals";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

export interface StoredProposalIteration {
  kind: ProposalIterationTarget["kind"];
  runId: string;
  sourceArtifactId: string;
  sourceArtifactGroupId: string;
  sourceRunId: string;
  sourceTriggerType: UnattendedOutputTriggerType;
  sourceThreadId: string;
  feedbackMessageId: string;
  requestedAt: string;
  requestedByUserId: string;
  sourceAppId?: string;
  sourceAppVersionId?: string;
}

export function proposalIterationFromRunInputs(
  value: unknown,
): StoredProposalIteration | null {
  if (!isRecord(value) || !isRecord(value.proposalIteration)) return null;
  const iteration = value.proposalIteration;
  if (
    (iteration.kind !== "artifact" && iteration.kind !== "app") ||
    !isNonEmptyString(iteration.runId) ||
    !isNonEmptyString(iteration.sourceArtifactId) ||
    !isNonEmptyString(iteration.sourceArtifactGroupId) ||
    !isNonEmptyString(iteration.sourceRunId) ||
    (iteration.sourceTriggerType !== "scheduled" &&
      iteration.sourceTriggerType !== "github_event") ||
    !isNonEmptyString(iteration.sourceThreadId) ||
    !isNonEmptyString(iteration.feedbackMessageId) ||
    !isNonEmptyString(iteration.requestedAt) ||
    !isNonEmptyString(iteration.requestedByUserId)
  ) {
    return null;
  }
  if (
    iteration.kind === "app" &&
    (!isNonEmptyString(iteration.sourceAppId) ||
      !isNonEmptyString(iteration.sourceAppVersionId))
  ) {
    return null;
  }
  return {
    kind: iteration.kind,
    runId: iteration.runId,
    sourceArtifactId: iteration.sourceArtifactId,
    sourceArtifactGroupId: iteration.sourceArtifactGroupId,
    sourceRunId: iteration.sourceRunId,
    sourceTriggerType: iteration.sourceTriggerType,
    sourceThreadId: iteration.sourceThreadId,
    feedbackMessageId: iteration.feedbackMessageId,
    requestedAt: iteration.requestedAt,
    requestedByUserId: iteration.requestedByUserId,
    ...(iteration.kind === "app"
      ? {
          sourceAppId: iteration.sourceAppId as string,
          sourceAppVersionId: iteration.sourceAppVersionId as string,
        }
      : {}),
  };
}

export function outputProposalContextForIteration(
  iteration: StoredProposalIteration,
  createdAt: Date,
): OutputProposalContext {
  return {
    runId: iteration.runId,
    triggerType: iteration.sourceTriggerType,
    createdAt: createdAt.toISOString(),
    iterationOf: proposalIterationLineage(iteration),
  };
}

export function proposalIterationLineage(
  iteration: StoredProposalIteration,
): OutputProposalIterationLineage {
  return {
    sourceArtifactId: iteration.sourceArtifactId,
    sourceRunId: iteration.sourceRunId,
    feedbackMessageId: iteration.feedbackMessageId,
    requestedAt: iteration.requestedAt,
    requestedByUserId: iteration.requestedByUserId,
    ...(iteration.sourceAppId
      ? { sourceAppId: iteration.sourceAppId }
      : {}),
    ...(iteration.sourceAppVersionId
      ? { sourceAppVersionId: iteration.sourceAppVersionId }
      : {}),
  };
}

export async function completeProposalIteration({
  db,
  iteration,
  replacementArtifact,
  replacementAppVersion,
  completedAt = new Date(),
  expectedWorkerId,
}: {
  db: Database;
  iteration: StoredProposalIteration;
  replacementArtifact: WorkspaceArtifactSummary;
  replacementAppVersion?: AppDraftVersionSummary;
  completedAt?: Date;
  expectedWorkerId?: string;
}): Promise<boolean> {
  if (
    replacementArtifact.artifactGroupId !==
      iteration.sourceArtifactGroupId ||
    replacementArtifact.supersedesArtifactId !== iteration.sourceArtifactId
  ) {
    return false;
  }
  if (
    iteration.kind === "app" &&
    (!replacementAppVersion ||
      replacementAppVersion.appId !== iteration.sourceAppId ||
      replacementAppVersion.artifactId !== replacementArtifact.id)
  ) {
    return false;
  }

  const sourceRows = await db
    .select()
    .from(workspaceArtifacts)
    .where(eq(workspaceArtifacts.id, iteration.sourceArtifactId))
    .limit(1);
  const source = sourceRows[0];
  if (!source) return false;
  const metadata = supersedeOutputProposalMetadata({
    metadata: source.metadata,
    runId: iteration.runId,
    replacementArtifactId: replacementArtifact.id,
    decidedAt: completedAt,
    decidedByUserId: iteration.requestedByUserId,
  });
  if (!metadata) return false;

  try {
    return await db.transaction(async (tx) => {
      if (expectedWorkerId) {
        const ownerRows = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, iteration.runId),
              eq(runs.status, "running"),
              eq(runs.workerId, expectedWorkerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!ownerRows[0]) throw new ProposalIterationTransitionConflict();
      }
      if (iteration.kind === "app") {
        const versionRows = await tx
          .update(appVersions)
          .set({ status: "superseded" })
          .where(
            and(
              eq(appVersions.id, iteration.sourceAppVersionId!),
              eq(appVersions.appId, iteration.sourceAppId!),
              eq(appVersions.status, "iterating"),
            ),
          )
          .returning({ id: appVersions.id });
        if (!versionRows[0]) throw new ProposalIterationTransitionConflict();
      }
      const artifactRows = await tx
        .update(workspaceArtifacts)
        .set({ metadata, updatedAt: completedAt })
        .where(
          and(
            eq(workspaceArtifacts.id, iteration.sourceArtifactId),
            sql`${workspaceArtifacts.metadata}->'outputProposal'->>'status' = 'iterating'`,
            sql`${workspaceArtifacts.metadata}->'outputProposal'->'iteration'->>'runId' = ${iteration.runId}`,
          ),
        )
        .returning({ id: workspaceArtifacts.id });
      if (!artifactRows[0]) throw new ProposalIterationTransitionConflict();

      await tx.insert(auditLog).values({
        actorUserId: iteration.requestedByUserId,
        actionType: "proposal_iteration_completed",
        status: "succeeded",
        provider: "ai-hub",
        toolName: "proposal_iteration",
        chatThreadId: iteration.sourceThreadId,
        chatMessageId: iteration.feedbackMessageId,
        runId: iteration.runId,
        input: {
          sourceArtifactId: iteration.sourceArtifactId,
          replacementArtifactId: replacementArtifact.id,
          ...(iteration.sourceAppId
            ? {
                sourceAppId: iteration.sourceAppId,
                sourceAppVersionId: iteration.sourceAppVersionId,
                replacementAppVersionId: replacementAppVersion?.id,
              }
            : {}),
        },
        metadata: {
          sourceRunId: iteration.sourceRunId,
          sourceTriggerType: iteration.sourceTriggerType,
        },
        startedAt: completedAt,
        completedAt,
      });
      return true;
    });
  } catch (error) {
    if (error instanceof ProposalIterationTransitionConflict) return false;
    throw error;
  }
}

export async function releaseProposalIteration({
  db,
  iteration,
  error,
  completedAt = new Date(),
  expectedWorkerId,
  replacementArtifactIds = [],
}: {
  db: Database;
  iteration: StoredProposalIteration;
  error: string;
  completedAt?: Date;
  expectedWorkerId?: string;
  replacementArtifactIds?: readonly string[];
}): Promise<boolean> {
  const sourceRows = await db
    .select()
    .from(workspaceArtifacts)
    .where(eq(workspaceArtifacts.id, iteration.sourceArtifactId))
    .limit(1);
  const source = sourceRows[0];
  if (!source) return false;
  const metadata = releaseOutputProposalIterationMetadata({
    metadata: source.metadata,
    runId: iteration.runId,
  });
  if (!metadata) return false;

  try {
    return await db.transaction(async (tx) => {
      if (expectedWorkerId) {
        const ownerRows = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, iteration.runId),
              eq(runs.status, "running"),
              eq(runs.workerId, expectedWorkerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!ownerRows[0]) throw new ProposalIterationTransitionConflict();
      }
      if (replacementArtifactIds.length > 0) {
        await tx
          .delete(workspaceArtifacts)
          .where(
            and(
              inArray(workspaceArtifacts.id, [...replacementArtifactIds]),
              eq(workspaceArtifacts.runId, iteration.runId),
            ),
          );
      }
      if (iteration.kind === "app") {
        const versionRows = await tx
          .update(appVersions)
          .set({ status: "proposed" })
          .where(
            and(
              eq(appVersions.id, iteration.sourceAppVersionId!),
              eq(appVersions.appId, iteration.sourceAppId!),
              eq(appVersions.status, "iterating"),
            ),
          )
          .returning({ id: appVersions.id });
        if (!versionRows[0]) throw new ProposalIterationTransitionConflict();
      }
      const artifactRows = await tx
        .update(workspaceArtifacts)
        .set({ metadata, updatedAt: completedAt })
        .where(
          and(
            eq(workspaceArtifacts.id, iteration.sourceArtifactId),
            sql`${workspaceArtifacts.metadata}->'outputProposal'->>'status' = 'iterating'`,
            sql`${workspaceArtifacts.metadata}->'outputProposal'->'iteration'->>'runId' = ${iteration.runId}`,
          ),
        )
        .returning({ id: workspaceArtifacts.id });
      if (!artifactRows[0]) throw new ProposalIterationTransitionConflict();

      await tx.insert(auditLog).values({
        actorUserId: iteration.requestedByUserId,
        actionType: "proposal_iteration_failed",
        status: "failed",
        provider: "ai-hub",
        toolName: "proposal_iteration",
        chatThreadId: iteration.sourceThreadId,
        chatMessageId: iteration.feedbackMessageId,
        runId: iteration.runId,
        input: {
          sourceArtifactId: iteration.sourceArtifactId,
          ...(iteration.sourceAppId
            ? {
                sourceAppId: iteration.sourceAppId,
                sourceAppVersionId: iteration.sourceAppVersionId,
              }
            : {}),
        },
        error,
        metadata: {
          sourceRunId: iteration.sourceRunId,
          sourceTriggerType: iteration.sourceTriggerType,
          restoredStatus: "proposed",
        },
        startedAt: completedAt,
        completedAt,
      });
      return true;
    });
  } catch (transitionError) {
    if (transitionError instanceof ProposalIterationTransitionConflict) {
      return false;
    }
    throw transitionError;
  }
}

export function sourceProposalForIteration(
  artifact: Pick<WorkspaceArtifact, "metadata">,
) {
  const proposal = outputProposalFromMetadata(artifact.metadata);
  return proposal?.status === "proposed" ? proposal : null;
}

class ProposalIterationTransitionConflict extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
