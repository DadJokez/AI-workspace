import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL_ID, normalizeUserTimeZone } from "@ai-workspace/agent";
import {
  appEditSessions,
  appVersions,
  apps,
  auditLog,
  chatMessages,
  chatThreads,
  getDb,
  runs,
  type App,
  type AppVersion,
  type Database,
  type WorkspaceArtifact,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  canAppRoleDeploy,
  canAppRoleEdit,
  loadAppVersion,
  resolveAppActorRole,
} from "@/lib/apps";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import { isModelEnabled, resolveModelForPurpose } from "@/lib/model-registry";
import {
  formatProposalIterationMessage,
  normalizeProposalIterationFeedback,
  parseProposalIterationTarget,
  reserveOutputProposalIterationMetadata,
  type OutputProposalMetadata,
} from "@/lib/output-proposals";
import {
  sourceProposalForIteration,
  type StoredProposalIteration,
} from "@/lib/proposal-iterations";
import {
  checkRateLimit,
  contentLengthTooLarge,
  requestLimitConfig,
} from "@/lib/request-limits";
import { appendRunEvent } from "@/lib/run-events";
import { toWorkspaceArtifactVersionTarget } from "@/lib/artifact-revisions";
import { loadWorkspaceArtifactForUser } from "@/lib/workspace-artifacts";
import { resolveAutonomyPreset } from "@/lib/autonomy-presets";
import {
  resolveNewRunBudget,
  runBudgetEnvelopeForEvent,
} from "@/lib/run-budget-policy";

export const dynamic = "force-dynamic";

const PROPOSAL_ITERATION_ROUTE: ChatRuntimeRoute = {
  lane: "durable-local",
  routingMode: "model-decided",
  executionMode: "local",
  runtimeTarget: "agentcore-worker",
  useWorker: true,
  useMcp: true,
  includeVaultContext: true,
  reasons: ["proposal_iteration"],
};

interface ProposalIterationRequestBody {
  threadId?: unknown;
  modelId?: unknown;
  timeZone?: unknown;
  proposalIteration?: {
    target?: unknown;
    feedback?: unknown;
  };
}

interface ProposalIterationCandidate {
  artifact: WorkspaceArtifact;
  proposal: OutputProposalMetadata;
  label: string;
  app?: App;
  appVersion?: AppVersion;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const limits = requestLimitConfig();
  if (contentLengthTooLarge(req.headers, limits.maxRequestBytes)) {
    return NextResponse.json(
      {
        error: "request_too_large",
        message: `Request body must be ${limits.maxRequestBytes} bytes or smaller.`,
      },
      { status: 413 },
    );
  }

  let body: ProposalIterationRequestBody;
  try {
    body = (await req.json()) as ProposalIterationRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const threadId =
    typeof body.threadId === "string" && body.threadId.trim()
      ? body.threadId.trim()
      : null;
  const target = parseProposalIterationTarget(
    body.proposalIteration?.target,
  );
  const feedback = normalizeProposalIterationFeedback(
    body.proposalIteration?.feedback,
  );
  if (!threadId || !target || !feedback) {
    return NextResponse.json(
      {
        error: "invalid_proposal_iteration",
        message: "Choose a pending proposal and add concise feedback.",
      },
      { status: 400 },
    );
  }

  const db = getDb();
  const rate = await checkRateLimit(
    db,
    `chat:${sessionUser.id}`,
    limits,
  );
  if (!rate.allowed) {
    await auditRateLimitDenial({
      db,
      userId: sessionUser.id,
      retryAfterSeconds: rate.retryAfterSeconds,
      resetAt: rate.resetAt,
      limits,
    });
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many chat requests. Please wait a moment and try again.",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
          "X-RateLimit-Reset": rate.resetAt.toISOString(),
        },
      },
    );
  }

  const threadRows = await db
    .select()
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, threadId),
        eq(chatThreads.userId, sessionUser.id),
      ),
    )
    .limit(1);
  const thread = threadRows[0];
  if (!thread) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  const candidateResult = await loadProposalIterationCandidate({
    db,
    userId: sessionUser.id,
    userRole: sessionUser.role,
    threadId,
    target,
  });
  if ("error" in candidateResult) {
    return NextResponse.json(
      {
        error: candidateResult.error,
        ...(candidateResult.message
          ? { message: candidateResult.message }
          : {}),
      },
      { status: candidateResult.status },
    );
  }
  const candidate = candidateResult.candidate;
  const requestedModelId =
    typeof body.modelId === "string" && body.modelId.trim()
      ? body.modelId.trim()
      : DEFAULT_MODEL_ID;
  const modelId = (await isModelEnabled(db, requestedModelId, "chat"))
    ? requestedModelId
    : await resolveModelForPurpose(db, "chat");
  const now = new Date();
  const runId = randomUUID();
  const feedbackMessageId = randomUUID();
  const message = formatProposalIterationMessage({
    label: candidate.label,
    feedback,
  });
  const reservation = {
    runId,
    feedbackMessageId,
    requestedAt: now.toISOString(),
    requestedByUserId: sessionUser.id,
  };
  const metadata = reserveOutputProposalIterationMetadata({
    metadata: candidate.artifact.metadata,
    reservation,
  });
  if (!metadata) {
    return NextResponse.json(
      { error: "proposal_not_pending" },
      { status: 409 },
    );
  }
  const proposalIteration: StoredProposalIteration = {
    kind: target.kind,
    runId,
    sourceArtifactId: candidate.artifact.id,
    sourceArtifactGroupId: candidate.artifact.artifactGroupId,
    sourceRunId: candidate.proposal.runId,
    sourceTriggerType: candidate.proposal.triggerType,
    sourceThreadId: thread.id,
    feedbackMessageId,
    requestedAt: now.toISOString(),
    requestedByUserId: sessionUser.id,
    ...(candidate.app && candidate.appVersion
      ? {
          sourceAppId: candidate.app.id,
          sourceAppVersionId: candidate.appVersion.id,
        }
      : {}),
  };
  const userTimeZone = normalizeUserTimeZone(body.timeZone);
  const runBudget = resolveNewRunBudget({
    lane: PROPOSAL_ITERATION_ROUTE.lane,
    triggerType: "proposal_iteration",
  });

  try {
    await db.transaction(async (tx) => {
      if (candidate.app && candidate.appVersion) {
        const versionRows = await tx
          .update(appVersions)
          .set({ status: "iterating" })
          .where(
            and(
              eq(appVersions.id, candidate.appVersion.id),
              eq(appVersions.appId, candidate.app.id),
              eq(appVersions.status, "proposed"),
            ),
          )
          .returning({ id: appVersions.id });
        if (!versionRows[0]) throw new ProposalIterationConflict();
      }
      const artifactRows = await tx
        .update(workspaceArtifacts)
        .set({ metadata, updatedAt: now })
        .where(
          and(
            eq(workspaceArtifacts.id, candidate.artifact.id),
            sql`${workspaceArtifacts.metadata}->'outputProposal'->>'status' = 'proposed'`,
          ),
        )
        .returning({ id: workspaceArtifacts.id });
      if (!artifactRows[0]) throw new ProposalIterationConflict();

      await tx.insert(chatMessages).values({
        id: feedbackMessageId,
        threadId: thread.id,
        role: "user",
        content: message,
      });
      await tx.insert(runs).values({
        id: runId,
        userId: sessionUser.id,
        threadId: thread.id,
        skillSlug: "chat-turn",
        triggerType: "proposal_iteration",
        status: "queued",
        modelId,
        inputs: {
          prompt: message,
          threadId: thread.id,
          userMessageId: feedbackMessageId,
          requestedByUserId: sessionUser.id,
          autonomyPreset: resolveAutonomyPreset("proposal_iteration").name,
          executionMode: "local",
          modelOverride: false,
          runtimeRoute: PROPOSAL_ITERATION_ROUTE,
          runBudget,
          artifactContextTarget: toWorkspaceArtifactVersionTarget(
            candidate.artifact,
          ),
          proposalIteration,
          ...(userTimeZone ? { userTimeZone } : {}),
        },
        attemptCount: 0,
        updatedAt: now,
      });
      await tx
        .update(chatThreads)
        .set({
          updatedAt: now,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
        })
        .where(eq(chatThreads.id, thread.id));
      await tx.insert(auditLog).values({
        actorUserId: sessionUser.id,
        actionType: "proposal_iteration_requested",
        status: "succeeded",
        provider: "ai-hub",
        toolName: "proposal_iteration",
        chatThreadId: thread.id,
        chatMessageId: feedbackMessageId,
        runId,
        input: {
          sourceArtifactId: candidate.artifact.id,
          feedback,
          ...(candidate.app && candidate.appVersion
            ? {
                sourceAppId: candidate.app.id,
                sourceAppVersionId: candidate.appVersion.id,
              }
            : {}),
        },
        metadata: {
          feedbackChars: feedback.length,
          sourceRunId: candidate.proposal.runId,
          sourceTriggerType: candidate.proposal.triggerType,
          transition: "proposed_to_iterating",
          runBudget: runBudgetEnvelopeForEvent(runBudget),
        },
        startedAt: now,
        completedAt: now,
      });
    });
  } catch (error) {
    if (error instanceof ProposalIterationConflict) {
      return NextResponse.json(
        { error: "proposal_not_pending" },
        { status: 409 },
      );
    }
    throw error;
  }

  try {
    await appendRunEvent({
      db,
      runId,
      sequence: 1,
      eventType: "run_queued",
      status: "pending",
      label: "Queued proposal iteration",
      metadata: {
        threadId: thread.id,
        modelId,
        userMessageId: feedbackMessageId,
        runtimeRoute: PROPOSAL_ITERATION_ROUTE,
        sourceArtifactId: candidate.artifact.id,
        runBudget: runBudgetEnvelopeForEvent(runBudget),
        ...(candidate.app && candidate.appVersion
          ? {
              sourceAppId: candidate.app.id,
              sourceAppVersionId: candidate.appVersion.id,
            }
          : {}),
      },
      occurredAt: now,
    });
  } catch (error) {
    process.stderr.write(
      `[proposal-iteration-run-event-error] ${JSON.stringify({
        runId,
        threadId: thread.id,
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  startInProcessChatRunWorker({ db, runId });
  return queuedIterationResponse({
    threadId: thread.id,
    runId,
    userMessageId: feedbackMessageId,
    modelId,
  });
}

async function loadProposalIterationCandidate({
  db,
  userId,
  userRole,
  threadId,
  target,
}: {
  db: Database;
  userId: string;
  userRole: "admin" | "user";
  threadId: string;
  target: NonNullable<ReturnType<typeof parseProposalIterationTarget>>;
}): Promise<
  | { candidate: ProposalIterationCandidate }
  | { error: string; status: number; message?: string }
> {
  if (target.kind === "artifact") {
    const artifact = await loadWorkspaceArtifactForUser({
      db,
      userId,
      artifactId: target.artifactId,
    });
    if (!artifact || artifact.threadId !== threadId) {
      return { error: "artifact_not_found", status: 404 };
    }
    const proposal = sourceProposalForIteration(artifact);
    if (!proposal) return { error: "proposal_not_pending", status: 409 };
    const appVersionRows = await db
      .select({ id: appVersions.id })
      .from(appVersions)
      .where(
        and(
          eq(appVersions.artifactId, artifact.id),
          inArray(appVersions.status, ["proposed", "iterating"]),
        ),
      )
      .limit(1);
    if (appVersionRows[0]) {
      return {
        error: "app_proposal",
        status: 409,
        message: "Iterate this proposal from its app version card.",
      };
    }
    return {
      candidate: {
        artifact,
        proposal,
        label: artifact.filename,
      },
    };
  }

  const appRows = await db
    .select()
    .from(apps)
    .where(eq(apps.id, target.appId))
    .limit(1);
  const app = appRows[0];
  if (!app) return { error: "app_not_found", status: 404 };
  const actorRole = await resolveAppActorRole(db, app, {
    id: userId,
    role: userRole,
  });
  if (!canAppRoleEdit(actorRole)) {
    return { error: "app_not_found", status: 404 };
  }
  const version = await loadAppVersion(db, app.id, target.appVersionId);
  if (
    !version ||
    version.status !== "proposed" ||
    version.id === app.liveVersionId ||
    version.sourceThreadId !== threadId
  ) {
    return { error: "version_not_found", status: 404 };
  }
  if (!canAppRoleDeploy(actorRole) && version.createdByUserId !== userId) {
    return { error: "version_not_found", status: 404 };
  }
  const artifactRows = await db
    .select()
    .from(workspaceArtifacts)
    .where(eq(workspaceArtifacts.id, version.artifactId))
    .limit(1);
  const artifact = artifactRows[0];
  if (!artifact || artifact.threadId !== threadId) {
    return { error: "artifact_not_found", status: 404 };
  }
  const proposal = sourceProposalForIteration(artifact);
  if (!proposal) return { error: "proposal_not_pending", status: 409 };
  const sessionRows = await db
    .select({ id: appEditSessions.id })
    .from(appEditSessions)
    .where(
      and(
        eq(appEditSessions.appId, app.id),
        eq(appEditSessions.threadId, threadId),
        eq(appEditSessions.createdByUserId, userId),
        eq(appEditSessions.status, "active"),
      ),
    )
    .limit(1);
  if (!sessionRows[0]) {
    return {
      error: "app_edit_session_inactive",
      status: 409,
      message: "Restart this app's edit session before iterating its proposal.",
    };
  }
  return {
    candidate: {
      artifact,
      proposal,
      label: app.name,
      app,
      appVersion: version,
    },
  };
}

async function auditRateLimitDenial({
  db,
  userId,
  retryAfterSeconds,
  resetAt,
  limits,
}: {
  db: Database;
  userId: string;
  retryAfterSeconds: number;
  resetAt: Date;
  limits: ReturnType<typeof requestLimitConfig>;
}) {
  const now = new Date();
  await db.insert(auditLog).values({
    actorUserId: userId,
    actionType: "rate_limit",
    status: "denied",
    provider: "ai-hub",
    toolName: "proposal_iteration",
    input: {
      route: "/api/output-proposals/iterate",
      windowMs: limits.windowMs,
      maxRequests: limits.maxRequests,
    },
    error: "chat_rate_limit_exceeded",
    metadata: {
      retryAfterSeconds,
      resetAt: resetAt.toISOString(),
    },
    startedAt: now,
    completedAt: now,
  });
}

function queuedIterationResponse({
  threadId,
  runId,
  userMessageId,
  modelId,
}: {
  threadId: string;
  runId: string;
  userMessageId: string;
  modelId: string;
}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of [
        {
          type: "meta",
          threadId,
          runId,
          userMessageId,
          modelId,
          modelOverride: false,
          executionMode: "local",
          runtimeRoute: PROPOSAL_ITERATION_ROUTE,
        },
        {
          type: "queued",
          threadId,
          runId,
          status: "Iterating on proposal",
        },
        { type: "done", stopReason: "queued" },
      ]) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

class ProposalIterationConflict extends Error {}
