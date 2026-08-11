import { randomUUID } from "node:crypto";

import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import type { SessionUser } from "@ai-workspace/auth";
import {
  appVersions,
  auditLog,
  chatMessages,
  chatThreadBranches,
  chatThreads,
  type ChatThreadBranchSourceType,
  type Database,
  workspaceArtifacts,
  type WorkspaceArtifact,
} from "@ai-workspace/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

import { resolveArtifactReviewAccess } from "@/lib/artifact-review-access";
import {
  artifactPromptContent,
  formatArtifactContext,
} from "@/lib/artifact-context";
import {
  toWorkspaceArtifactVersionTarget,
  type WorkspaceArtifactVersionTarget,
} from "@/lib/artifact-revisions";
import { outputProposalFromMetadata } from "@/lib/output-proposals";
import type {
  ThreadBranchLineage,
  ThreadBranchLineageResource,
  ThreadBranchRequest,
  ThreadBranchSourceType,
  ThreadAlternativeLink,
} from "@/lib/thread-branch-types";
import {
  serializeWorkspaceArtifact,
  type WorkspaceArtifactSummary,
} from "@/lib/workspace-artifacts";

const SNAPSHOT_VERSION = 1;
const MAX_BRANCH_TITLE_CHARS = 200;
const PENDING_APP_VERSION_STATUSES = new Set([
  "draft",
  "proposed",
  "iterating",
]);
const PENDING_PROPOSAL_STATUSES = new Set(["proposed", "iterating"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ThreadBranchSnapshotMessage {
  id: string;
  sourceMessageIdSnapshot: string;
  originMessageIdSnapshot: string;
  originThreadIdSnapshot: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId: string | null;
  runtime: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: string;
}

export interface ThreadBranchSnapshotResource {
  artifactIdSnapshot: string;
  messageId: string | null;
  title: string;
  filename: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  artifactGroupId: string;
  versionNumber: number;
  appVersionIdSnapshot?: string;
  appVersionStatus?: string;
  proposalStatus?: string;
}

export interface ThreadBranchSnapshotV1 {
  version: 1;
  sourceTitle: string;
  messages: ThreadBranchSnapshotMessage[];
  resources: ThreadBranchSnapshotResource[];
  primaryArtifactIdSnapshot?: string;
  primaryAppVersionIdSnapshot?: string;
}

interface BranchableMessage extends ThreadBranchSnapshotMessage {
  liveMessageId: string | null;
}

interface CreateThreadBranchInput {
  db: Database;
  actor: Pick<SessionUser, "id" | "role">;
  request: ThreadBranchRequest;
  now?: Date;
}

export class ThreadBranchError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ThreadBranchError";
  }
}

export function parseThreadBranchRequest(value: unknown): ThreadBranchRequest {
  if (!isRecord(value) || !isThreadBranchSourceType(value.sourceType)) {
    throw new ThreadBranchError(
      "invalid_branch_request",
      400,
      "Choose a message, chat, artifact, app version, or proposal to branch.",
    );
  }
  const request: ThreadBranchRequest = { sourceType: value.sourceType };
  for (const key of [
    "sourceThreadId",
    "sourceMessageId",
    "artifactId",
    "appVersionId",
  ] as const) {
    const candidate = value[key];
    if (candidate !== undefined) {
      if (
        typeof candidate !== "string" ||
        !candidate.trim() ||
        !UUID_PATTERN.test(candidate.trim())
      ) {
        throw new ThreadBranchError(
          "invalid_branch_request",
          400,
          `${key} must be a valid identifier.`,
        );
      }
      request[key] = candidate.trim();
    }
  }
  if (
    (request.sourceType === "message" || request.sourceType === "thread") &&
    !request.sourceThreadId
  ) {
    throw new ThreadBranchError(
      "source_thread_required",
      400,
      "Open a saved chat before branching this work.",
    );
  }
  if (request.sourceType === "message" && !request.sourceMessageId) {
    throw new ThreadBranchError(
      "source_message_required",
      400,
      "Choose the message where the alternate approach should begin.",
    );
  }
  if (
    (request.sourceType === "artifact" ||
      request.sourceType === "app_version" ||
      request.sourceType === "proposal") &&
    !request.artifactId
  ) {
    throw new ThreadBranchError(
      "source_artifact_required",
      400,
      "Choose the file or proposal to branch.",
    );
  }
  if (request.sourceType === "app_version" && !request.appVersionId) {
    throw new ThreadBranchError(
      "source_app_version_required",
      400,
      "Choose the app version to branch.",
    );
  }
  return request;
}

export async function createThreadBranch({
  db,
  actor,
  request,
  now = new Date(),
}: CreateThreadBranchInput) {
  return db.transaction(async (tx) => {
    const sourceArtifact = request.artifactId
      ? await loadAuthorizedArtifact({
          db: tx as unknown as Database,
          actor,
          artifactId: request.artifactId,
        })
      : null;
    if (request.artifactId && !sourceArtifact) {
      throw new ThreadBranchError(
        "branch_source_not_found",
        404,
        "That source is unavailable or you no longer have access to it.",
      );
    }

    let sourceAppVersion: {
      id: string;
      artifactId: string;
      status: string;
    } | null = null;
    if (request.sourceType === "app_version") {
      const rows = await tx
        .select({
          id: appVersions.id,
          artifactId: appVersions.artifactId,
          status: appVersions.status,
        })
        .from(appVersions)
        .where(eq(appVersions.id, request.appVersionId!))
        .limit(1);
      sourceAppVersion = rows[0] ?? null;
      if (
        !sourceAppVersion ||
        sourceAppVersion.artifactId !== sourceArtifact?.id
      ) {
        throw new ThreadBranchError(
          "branch_source_not_found",
          404,
          "That app version is unavailable or no longer matches the selected file.",
        );
      }
    }
    if (
      request.sourceType === "proposal" &&
      !outputProposalFromMetadata(sourceArtifact?.metadata)
    ) {
      throw new ThreadBranchError(
        "proposal_not_found",
        409,
        "That file is no longer an identifiable proposal.",
      );
    }

    let parent = request.sourceThreadId
      ? await loadOwnedThread(
          tx as unknown as Database,
          actor.id,
          request.sourceThreadId,
        )
      : null;
    if (request.sourceThreadId && !parent) {
      throw new ThreadBranchError(
        "branch_source_not_found",
        404,
        "That chat is unavailable or is not yours to branch.",
      );
    }

    if (!parent && sourceArtifact?.threadId) {
      parent = await loadOwnedThread(
        tx as unknown as Database,
        actor.id,
        sourceArtifact.threadId,
      );
    }

    let effectiveMessages: BranchableMessage[] = [];
    let inheritedResources: ThreadBranchSnapshotResource[] = [];
    if (parent) {
      const parentSnapshot = await loadThreadBranchSnapshot({
        db: tx as unknown as Database,
        threadId: parent.id,
      });
      const liveMessages = await tx
        .select({
          id: chatMessages.id,
          role: chatMessages.role,
          content: chatMessages.content,
          modelId: chatMessages.modelId,
          runtime: chatMessages.runtime,
          tokensIn: chatMessages.tokensIn,
          tokensOut: chatMessages.tokensOut,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(eq(chatMessages.threadId, parent.id))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
      effectiveMessages = [
        ...(parentSnapshot?.messages ?? []).map((message) => ({
          ...message,
          liveMessageId: null,
        })),
        ...liveMessages
          .filter((message) => message.role !== "tool")
          .map((message) => ({
            id: message.id,
            sourceMessageIdSnapshot: message.id,
            originMessageIdSnapshot: message.id,
            originThreadIdSnapshot: parent!.id,
            role: message.role,
            content: message.content,
            modelId: message.modelId,
            runtime: message.runtime,
            tokensIn: message.tokensIn,
            tokensOut: message.tokensOut,
            createdAt: message.createdAt.toISOString(),
            liveMessageId: message.id,
          })),
      ];
      inheritedResources = parentSnapshot?.resources ?? [];
    }

    let branchPointIndex = -1;
    if (request.sourceType === "message") {
      branchPointIndex = effectiveMessages.findIndex(
        (message) => message.id === request.sourceMessageId,
      );
      if (branchPointIndex < 0) {
        throw new ThreadBranchError(
          "branch_message_not_found",
          404,
          "That message is no longer available in this chat.",
        );
      }
    } else if (request.sourceType === "thread") {
      branchPointIndex = effectiveMessages.length - 1;
      if (branchPointIndex < 0) {
        throw new ThreadBranchError(
          "empty_branch_source",
          409,
          "There is no saved work in this chat to branch yet.",
        );
      }
    } else if (sourceArtifact && parent) {
      const inherited = inheritedResources.find(
        (resource) =>
          resource.artifactIdSnapshot === sourceArtifact.id &&
          resource.messageId,
      );
      const sourceMessageId = inherited?.messageId ?? sourceArtifact.chatMessageId;
      if (sourceMessageId) {
        branchPointIndex = effectiveMessages.findIndex(
          (message) => message.id === sourceMessageId,
        );
      }
      // An artifact opened alongside an unrelated chat must not pull that
      // chat into the branch. Only retain a parent whose history contains the
      // selected source.
      if (branchPointIndex < 0) parent = null;
    }

    const selectedMessages =
      branchPointIndex >= 0
        ? effectiveMessages.slice(0, branchPointIndex + 1)
        : [];
    const sourceToBranchMessageId = new Map<string, string>();
    const snapshotMessages: ThreadBranchSnapshotMessage[] = selectedMessages.map(
      (message) => {
        const id = randomUUID();
        sourceToBranchMessageId.set(message.id, id);
        return {
          id,
          sourceMessageIdSnapshot: message.id,
          originMessageIdSnapshot: message.originMessageIdSnapshot,
          originThreadIdSnapshot: message.originThreadIdSnapshot,
          role: message.role,
          content: message.content,
          modelId: message.modelId,
          runtime: message.runtime,
          tokensIn: message.tokensIn,
          tokensOut: message.tokensOut,
          createdAt: message.createdAt,
        };
      },
    );

    const selectedSourceIds = new Set(
      selectedMessages.map((message) => message.id),
    );
    const resources: ThreadBranchSnapshotResource[] = inheritedResources
      .filter(
        (resource) =>
          (resource.messageId === null ||
            selectedSourceIds.has(resource.messageId)) &&
          (resource.artifactIdSnapshot === sourceArtifact?.id ||
            (!PENDING_PROPOSAL_STATUSES.has(resource.proposalStatus ?? "") &&
              !PENDING_APP_VERSION_STATUSES.has(
                resource.appVersionStatus ?? "",
              ))),
      )
      .map((resource) => ({
        ...resource,
        messageId: resource.messageId
          ? sourceToBranchMessageId.get(resource.messageId) ?? null
          : null,
      }));

    const selectedLiveMessageIds = selectedMessages.flatMap((message) =>
      message.liveMessageId ? [message.liveMessageId] : [],
    );
    if (selectedLiveMessageIds.length > 0) {
      const linkedArtifacts = await tx
        .select()
        .from(workspaceArtifacts)
        .where(inArray(workspaceArtifacts.chatMessageId, selectedLiveMessageIds))
        .orderBy(asc(workspaceArtifacts.createdAt), asc(workspaceArtifacts.id));
      const appVersionRows = linkedArtifacts.length
        ? await tx
            .select({
              artifactId: appVersions.artifactId,
              id: appVersions.id,
              status: appVersions.status,
            })
            .from(appVersions)
            .where(
              inArray(
                appVersions.artifactId,
                linkedArtifacts.map((artifact) => artifact.id),
              ),
            )
        : [];
      const appVersionByArtifactId = new Map(
        appVersionRows.map((version) => [version.artifactId, version]),
      );
      for (const artifact of linkedArtifacts) {
        const appVersion = appVersionByArtifactId.get(artifact.id);
        const proposal = outputProposalFromMetadata(artifact.metadata);
        const explicit = artifact.id === sourceArtifact?.id;
        if (
          !explicit &&
          ((appVersion && PENDING_APP_VERSION_STATUSES.has(appVersion.status)) ||
            (proposal && PENDING_PROPOSAL_STATUSES.has(proposal.status)))
        ) {
          continue;
        }
        resources.push(
          snapshotResourceFromArtifact({
            artifact,
            messageId: artifact.chatMessageId
              ? sourceToBranchMessageId.get(artifact.chatMessageId) ?? null
              : null,
            appVersionId: appVersion?.id,
            appVersionStatus: appVersion?.status,
            proposalStatus: proposal?.status,
          }),
        );
      }
    }

    if (
      sourceArtifact &&
      !resources.some(
        (resource) => resource.artifactIdSnapshot === sourceArtifact.id,
      )
    ) {
      const proposal = outputProposalFromMetadata(sourceArtifact.metadata);
      resources.push(
        snapshotResourceFromArtifact({
          artifact: sourceArtifact,
          messageId:
            sourceArtifact.chatMessageId &&
            sourceToBranchMessageId.has(sourceArtifact.chatMessageId)
              ? sourceToBranchMessageId.get(sourceArtifact.chatMessageId)!
              : null,
          appVersionId: sourceAppVersion?.id,
          appVersionStatus: sourceAppVersion?.status,
          proposalStatus: proposal?.status,
        }),
      );
    }

    const dedupedResources = Array.from(
      new Map(
        resources.map((resource) => [resource.artifactIdSnapshot, resource]),
      ).values(),
    );
    const sourceTitle =
      sourceArtifact?.title ?? parent?.title?.trim() ?? "Untitled chat";
    const snapshot: ThreadBranchSnapshotV1 = {
      version: SNAPSHOT_VERSION,
      sourceTitle,
      messages: snapshotMessages,
      resources: dedupedResources,
      ...(sourceArtifact
        ? { primaryArtifactIdSnapshot: sourceArtifact.id }
        : {}),
      ...(sourceAppVersion
        ? { primaryAppVersionIdSnapshot: sourceAppVersion.id }
        : {}),
    };
    const branchPoint = selectedMessages.at(-1) ?? null;
    const title = alternateTitle(sourceTitle);
    const createdRows = await tx
      .insert(chatThreads)
      .values({
        userId: actor.id,
        title,
        titleSource: "auto",
        defaultModelId: parent?.defaultModelId ?? DEFAULT_MODEL_ID,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const thread = createdRows[0]!;

    await tx.insert(chatThreadBranches).values({
      threadId: thread.id,
      parentThreadId: parent?.id ?? null,
      parentThreadIdSnapshot: parent?.id ?? null,
      branchPointMessageId: branchPoint?.liveMessageId ?? null,
      branchPointMessageIdSnapshot: branchPoint?.id ?? null,
      sourceType: request.sourceType as ChatThreadBranchSourceType,
      sourceArtifactId: sourceArtifact?.id ?? null,
      sourceArtifactIdSnapshot: sourceArtifact?.id ?? null,
      sourceAppVersionId: sourceAppVersion?.id ?? null,
      sourceAppVersionIdSnapshot: sourceAppVersion?.id ?? null,
      createdByUserId: actor.id,
      snapshot,
      createdAt: now,
    });
    await tx.insert(auditLog).values({
      actorUserId: actor.id,
      actionType: "chat_thread_branch",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "chat_thread_branch",
      chatThreadId: thread.id,
      chatMessageId: branchPoint?.liveMessageId ?? null,
      input: {
        sourceType: request.sourceType,
        parentThreadIdSnapshot: parent?.id ?? null,
        branchPointMessageIdSnapshot: branchPoint?.id ?? null,
        sourceArtifactIdSnapshot: sourceArtifact?.id ?? null,
        sourceAppVersionIdSnapshot: sourceAppVersion?.id ?? null,
      },
      output: {
        branchThreadId: thread.id,
        snapshotMessages: snapshot.messages.length,
        pinnedResources: snapshot.resources.length,
      },
      startedAt: now,
      completedAt: now,
      createdAt: now,
    });

    return { thread, snapshot };
  });
}

export async function loadThreadBranchSnapshot({
  db,
  threadId,
}: {
  db: Database;
  threadId: string;
}): Promise<ThreadBranchSnapshotV1 | null> {
  const rows = await db
    .select({ snapshot: chatThreadBranches.snapshot })
    .from(chatThreadBranches)
    .where(eq(chatThreadBranches.threadId, threadId))
    .limit(1);
  return parseThreadBranchSnapshot(rows[0]?.snapshot);
}

export async function loadThreadPromptHistory({
  db,
  threadId,
}: {
  db: Database;
  threadId: string;
}) {
  const [snapshot, liveMessages] = await Promise.all([
    loadThreadBranchSnapshot({ db, threadId }),
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id)),
  ]);
  return [
    ...(snapshot?.messages ?? []).map((message) => ({
      id: message.id,
      threadId,
      role: message.role,
      content: message.content,
      modelId: message.modelId,
      runtime: message.runtime,
      tokensIn: message.tokensIn,
      tokensOut: message.tokensOut,
      toolCalls: null,
      toolResults: null,
      createdAt: new Date(message.createdAt),
    })),
    ...liveMessages,
  ];
}

export async function loadThreadBranchLineage({
  db,
  threadId,
  actor,
}: {
  db: Database;
  threadId: string;
  actor: Pick<SessionUser, "id" | "role">;
}): Promise<ThreadBranchLineage | null> {
  const rows = await db
    .select()
    .from(chatThreadBranches)
    .where(eq(chatThreadBranches.threadId, threadId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const snapshot = parseThreadBranchSnapshot(row.snapshot);
  if (!snapshot) return null;
  const availability = await loadBranchResourceAvailability({
    db,
    actor,
    resources: snapshot.resources,
  });
  return {
    sourceType: row.sourceType,
    sourceTitle: snapshot.sourceTitle,
    parentThreadId: row.parentThreadId,
    parentThreadIdSnapshot: row.parentThreadIdSnapshot,
    branchPointMessageId: row.branchPointMessageId,
    branchPointMessageIdSnapshot: row.branchPointMessageIdSnapshot,
    sourceArtifactId: availability.get(row.sourceArtifactIdSnapshot ?? "")
      ?.artifactId ?? null,
    sourceArtifactIdSnapshot: row.sourceArtifactIdSnapshot,
    sourceAppVersionId: availability.get(row.sourceArtifactIdSnapshot ?? "")
      ?.artifactId
      ? row.sourceAppVersionId
      : null,
    sourceAppVersionIdSnapshot: row.sourceAppVersionIdSnapshot,
    messageCount: snapshot.messages.length,
    resources: snapshot.resources.map((resource) => {
      const current = availability.get(resource.artifactIdSnapshot);
      return {
        artifactIdSnapshot: resource.artifactIdSnapshot,
        ...(current?.artifactId ? { artifactId: current.artifactId } : {}),
        messageId: resource.messageId,
        title: resource.title,
        filename: resource.filename,
        kind: resource.kind,
        versionNumber: resource.versionNumber,
        ...(resource.appVersionIdSnapshot
          ? { appVersionIdSnapshot: resource.appVersionIdSnapshot }
          : {}),
        ...(resource.proposalStatus
          ? { proposalStatus: resource.proposalStatus }
          : {}),
        status: current?.status ?? "unavailable",
      } satisfies ThreadBranchLineageResource;
    }),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadThreadAlternativeLinks({
  db,
  threadId,
  actor,
}: {
  db: Database;
  threadId: string;
  actor: Pick<SessionUser, "id" | "role">;
}): Promise<ThreadAlternativeLink[]> {
  const ownerScope =
    actor.role === "admin" ? undefined : eq(chatThreads.userId, actor.id);
  const rows = await db
    .select({
      threadId: chatThreadBranches.threadId,
      title: chatThreads.title,
      sourceType: chatThreadBranches.sourceType,
      createdAt: chatThreadBranches.createdAt,
    })
    .from(chatThreadBranches)
    .innerJoin(chatThreads, eq(chatThreads.id, chatThreadBranches.threadId))
    .where(
      ownerScope
        ? and(eq(chatThreadBranches.parentThreadId, threadId), ownerScope)
        : eq(chatThreadBranches.parentThreadId, threadId),
    )
    .orderBy(desc(chatThreadBranches.createdAt));
  return rows.map((row) => ({
    threadId: row.threadId,
    title: row.title?.trim() || "Alternative approach",
    sourceType: row.sourceType,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function loadThreadBranchSnapshotArtifacts({
  db,
  threadId,
  actor,
}: {
  db: Database;
  threadId: string;
  actor?: Pick<SessionUser, "id" | "role">;
}): Promise<{
  messages: ThreadBranchSnapshotMessage[];
  artifactsByMessageId: Map<string, WorkspaceArtifactSummary[]>;
}> {
  const snapshot = await loadThreadBranchSnapshot({ db, threadId });
  if (!snapshot) {
    return { messages: [], artifactsByMessageId: new Map() };
  }
  const artifactsByMessageId = new Map<string, WorkspaceArtifactSummary[]>();
  if (!actor) return { messages: snapshot.messages, artifactsByMessageId };
  const availability = await loadBranchResourceAvailability({
    db,
    actor,
    resources: snapshot.resources,
  });
  for (const resource of snapshot.resources) {
    if (!resource.messageId) continue;
    const current = availability.get(resource.artifactIdSnapshot);
    if (!current?.artifact) continue;
    const existing = artifactsByMessageId.get(resource.messageId) ?? [];
    existing.push(serializeWorkspaceArtifact(current.artifact));
    artifactsByMessageId.set(resource.messageId, existing);
  }
  return { messages: snapshot.messages, artifactsByMessageId };
}

export interface ThreadBranchArtifactContext {
  sourceArtifactId: string;
  text: string;
  separateFromArtifact: WorkspaceArtifactVersionTarget | null;
}

export async function loadThreadBranchArtifactContext({
  db,
  threadId,
  actor,
}: {
  db: Database;
  threadId: string;
  actor: Pick<SessionUser, "id" | "role">;
}): Promise<ThreadBranchArtifactContext | null> {
  const branchRows = await db
    .select({
      sourceType: chatThreadBranches.sourceType,
      sourceArtifactId: chatThreadBranches.sourceArtifactId,
      sourceArtifactIdSnapshot: chatThreadBranches.sourceArtifactIdSnapshot,
      snapshot: chatThreadBranches.snapshot,
    })
    .from(chatThreadBranches)
    .where(eq(chatThreadBranches.threadId, threadId))
    .limit(1);
  const branch = branchRows[0];
  if (
    !branch ||
    (branch.sourceType !== "artifact" &&
      branch.sourceType !== "app_version" &&
      branch.sourceType !== "proposal")
  ) {
    return null;
  }
  const snapshot = parseThreadBranchSnapshot(branch.snapshot);
  const snapshotResource = snapshot?.resources.find(
    (resource) =>
      resource.artifactIdSnapshot === branch.sourceArtifactIdSnapshot,
  );
  if (!snapshotResource) return null;

  const branchArtifacts = await db
    .select({ id: workspaceArtifacts.id })
    .from(workspaceArtifacts)
    .where(
      and(
        eq(workspaceArtifacts.threadId, threadId),
        ne(workspaceArtifacts.source, "user-upload"),
      ),
    )
    .limit(1);
  if (branchArtifacts.length > 0) return null;

  const artifact = branch.sourceArtifactId
    ? await loadAuthorizedArtifact({
        db,
        actor,
        artifactId: branch.sourceArtifactId,
      })
    : null;
  if (!artifact) {
    return {
      sourceArtifactId: snapshotResource.artifactIdSnapshot,
      text:
        `This chat was branched from "${snapshotResource.title}" (${snapshotResource.filename}), ` +
        "but that pinned source is now unavailable or access was revoked. Do not recreate it from memory or claim to have read it. Tell the user the source is unavailable and ask them to restore access or choose another file.",
      separateFromArtifact: null,
    };
  }
  const promptContent = artifactPromptContent({
    source: artifact.source,
    content: artifact.content,
    metadata: artifact.metadata,
  });
  const summary = serializeWorkspaceArtifact(artifact);
  return {
    sourceArtifactId: artifact.id,
    text: formatArtifactContext({
      artifacts: [summary],
      matched: {
        title: artifact.title,
        filename: artifact.filename,
        content: promptContent.content,
        complete: promptContent.complete,
      },
      mode: "separate",
    }),
    separateFromArtifact: toWorkspaceArtifactVersionTarget(artifact),
  };
}

export async function threadBranchHasPinnedResource({
  db,
  threadId,
  artifactId,
}: {
  db: Database;
  threadId: string;
  artifactId: string;
}): Promise<boolean> {
  const snapshot = await loadThreadBranchSnapshot({ db, threadId });
  return Boolean(
    snapshot?.resources.some(
      (resource) => resource.artifactIdSnapshot === artifactId,
    ),
  );
}

export function parseThreadBranchSnapshot(
  value: unknown,
): ThreadBranchSnapshotV1 | null {
  if (
    !isRecord(value) ||
    value.version !== SNAPSHOT_VERSION ||
    typeof value.sourceTitle !== "string" ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.resources)
  ) {
    return null;
  }
  const messages = value.messages.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.sourceMessageIdSnapshot !== "string" ||
      typeof candidate.originMessageIdSnapshot !== "string" ||
      typeof candidate.originThreadIdSnapshot !== "string" ||
      !isMessageRole(candidate.role) ||
      typeof candidate.content !== "string" ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt))
    ) {
      return [];
    }
    return [
      {
        id: candidate.id,
        sourceMessageIdSnapshot: candidate.sourceMessageIdSnapshot,
        originMessageIdSnapshot: candidate.originMessageIdSnapshot,
        originThreadIdSnapshot: candidate.originThreadIdSnapshot,
        role: candidate.role,
        content: candidate.content,
        modelId: nullableString(candidate.modelId),
        runtime: nullableString(candidate.runtime),
        tokensIn: nullableInteger(candidate.tokensIn),
        tokensOut: nullableInteger(candidate.tokensOut),
        createdAt: candidate.createdAt,
      } satisfies ThreadBranchSnapshotMessage,
    ];
  });
  if (messages.length !== value.messages.length) return null;
  const resources = value.resources.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    if (
      typeof candidate.artifactIdSnapshot !== "string" ||
      (candidate.messageId !== null && typeof candidate.messageId !== "string") ||
      typeof candidate.title !== "string" ||
      typeof candidate.filename !== "string" ||
      typeof candidate.kind !== "string" ||
      typeof candidate.mimeType !== "string" ||
      typeof candidate.sizeBytes !== "number" ||
      typeof candidate.source !== "string" ||
      typeof candidate.artifactGroupId !== "string" ||
      typeof candidate.versionNumber !== "number"
    ) {
      return [];
    }
    return [
      {
        artifactIdSnapshot: candidate.artifactIdSnapshot,
        messageId: candidate.messageId,
        title: candidate.title,
        filename: candidate.filename,
        kind: candidate.kind,
        mimeType: candidate.mimeType,
        sizeBytes: candidate.sizeBytes,
        source: candidate.source,
        artifactGroupId: candidate.artifactGroupId,
        versionNumber: candidate.versionNumber,
        ...(typeof candidate.appVersionIdSnapshot === "string"
          ? { appVersionIdSnapshot: candidate.appVersionIdSnapshot }
          : {}),
        ...(typeof candidate.appVersionStatus === "string"
          ? { appVersionStatus: candidate.appVersionStatus }
          : {}),
        ...(typeof candidate.proposalStatus === "string"
          ? { proposalStatus: candidate.proposalStatus }
          : {}),
      } satisfies ThreadBranchSnapshotResource,
    ];
  });
  if (resources.length !== value.resources.length) return null;
  return {
    version: SNAPSHOT_VERSION,
    sourceTitle: value.sourceTitle,
    messages,
    resources,
    ...(typeof value.primaryArtifactIdSnapshot === "string"
      ? { primaryArtifactIdSnapshot: value.primaryArtifactIdSnapshot }
      : {}),
    ...(typeof value.primaryAppVersionIdSnapshot === "string"
      ? { primaryAppVersionIdSnapshot: value.primaryAppVersionIdSnapshot }
      : {}),
  };
}

async function loadOwnedThread(db: Database, userId: string, threadId: string) {
  const rows = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function loadAuthorizedArtifact({
  db,
  actor,
  artifactId,
}: {
  db: Database;
  actor: Pick<SessionUser, "id" | "role">;
  artifactId: string;
}): Promise<WorkspaceArtifact | null> {
  if (actor.role === "admin") {
    const rows = await db
      .select()
      .from(workspaceArtifacts)
      .where(eq(workspaceArtifacts.id, artifactId))
      .limit(1);
    return rows[0] ?? null;
  }
  const access = await resolveArtifactReviewAccess({ db, actor, artifactId });
  return access?.artifact ?? null;
}

async function loadBranchResourceAvailability({
  db,
  actor,
  resources,
}: {
  db: Database;
  actor: Pick<SessionUser, "id" | "role">;
  resources: readonly ThreadBranchSnapshotResource[];
}): Promise<
  Map<
    string,
    {
      status: "available" | "unavailable";
      artifactId?: string;
      artifact?: WorkspaceArtifact;
    }
  >
> {
  const result = new Map<
    string,
    {
      status: "available" | "unavailable";
      artifactId?: string;
      artifact?: WorkspaceArtifact;
    }
  >();
  const ids = Array.from(
    new Set(resources.map((resource) => resource.artifactIdSnapshot)),
  );
  if (ids.length === 0) return result;
  const rows = await db
    .select()
    .from(workspaceArtifacts)
    .where(inArray(workspaceArtifacts.id, ids));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row) {
      result.set(id, { status: "unavailable" });
      continue;
    }
    if (actor.role === "admin" || row.userId === actor.id) {
      result.set(id, {
        status: "available",
        artifactId: row.id,
        artifact: row,
      });
      continue;
    }
    const access = await resolveArtifactReviewAccess({
      db,
      actor,
      artifactId: id,
    });
    result.set(
      id,
      access
        ? {
            status: "available",
            artifactId: access.artifact.id,
            artifact: access.artifact,
          }
        : { status: "unavailable" },
    );
  }
  return result;
}

function snapshotResourceFromArtifact({
  artifact,
  messageId,
  appVersionId,
  appVersionStatus,
  proposalStatus,
}: {
  artifact: WorkspaceArtifact;
  messageId: string | null;
  appVersionId?: string;
  appVersionStatus?: string;
  proposalStatus?: string;
}): ThreadBranchSnapshotResource {
  return {
    artifactIdSnapshot: artifact.id,
    messageId,
    title: artifact.title,
    filename: artifact.filename,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    source: artifact.source,
    artifactGroupId: artifact.artifactGroupId,
    versionNumber: artifact.versionNumber,
    ...(appVersionId ? { appVersionIdSnapshot: appVersionId } : {}),
    ...(appVersionStatus ? { appVersionStatus } : {}),
    ...(proposalStatus ? { proposalStatus } : {}),
  };
}

function alternateTitle(sourceTitle: string): string {
  const compact = sourceTitle.replace(/\s+/g, " ").trim() || "Untitled work";
  return `Alternative: ${compact}`.slice(0, MAX_BRANCH_TITLE_CHARS);
}

function isThreadBranchSourceType(
  value: unknown,
): value is ThreadBranchSourceType {
  return (
    value === "message" ||
    value === "thread" ||
    value === "artifact" ||
    value === "app_version" ||
    value === "proposal"
  );
}

function isMessageRole(value: unknown): value is "user" | "assistant" | "tool" {
  return value === "user" || value === "assistant" || value === "tool";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
