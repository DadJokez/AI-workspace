import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL_ID, normalizeUserTimeZone } from "@ai-workspace/agent";
import {
  artifactReviewComments,
  auditLog,
  chatMessages,
  chatThreads,
  getDb,
  runs,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { resolveArtifactReviewAccess } from "@/lib/artifact-review-access";
import {
  formatArtifactReviewMessage,
  parseArtifactReviewAnchor,
  parseArtifactReviewSelection,
  type StoredArtifactReviewRequest,
} from "@/lib/artifact-review";
import { toWorkspaceArtifactVersionTarget } from "@/lib/artifact-revisions";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import { isModelEnabled, resolveModelForPurpose } from "@/lib/model-registry";
import {
  checkRateLimit,
  contentLengthTooLarge,
  requestLimitConfig,
} from "@/lib/request-limits";
import { appendRunEvent } from "@/lib/run-events";
import { resolveAutonomyPreset } from "@/lib/autonomy-presets";
import {
  resolveNewRunBudget,
  runBudgetEnvelopeForEvent,
} from "@/lib/run-budget-policy";

export const dynamic = "force-dynamic";

const ARTIFACT_REVIEW_ROUTE: ChatRuntimeRoute = {
  lane: "durable-local",
  routingMode: "model-decided",
  executionMode: "local",
  runtimeTarget: "agentcore-worker",
  useWorker: true,
  useMcp: true,
  includeVaultContext: true,
  reasons: ["artifact_review"],
};

class ArtifactReviewRequestConflict extends Error {
  constructor(readonly code: "artifact_stale_base" | "comment_changed") {
    super(code);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const limits = requestLimitConfig();
  if (contentLengthTooLarge(req.headers, limits.maxRequestBytes)) {
    return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = (await req.json()) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const selections = parseArtifactReviewSelection(body.comments);
  const threadId = nonEmptyString(body.threadId);
  if (!selections || !threadId) {
    return NextResponse.json(
      {
        error: "invalid_artifact_review_request",
        message: "Select at least one open review comment.",
      },
      { status: 400 },
    );
  }

  const { id } = await params;
  const db = getDb();
  const access = await resolveArtifactReviewAccess({
    db,
    actor: session.user,
    artifactId: id,
  });
  if (!access || !access.canAddress) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
  const threadRows = await db
    .select()
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, threadId),
        eq(chatThreads.userId, session.user.id),
      ),
    )
    .limit(1);
  const thread = threadRows[0];
  if (!thread) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }
  const runBudget = resolveNewRunBudget({
    lane: ARTIFACT_REVIEW_ROUTE.lane,
    triggerType: "artifact_review",
  });
  const rate = await checkRateLimit(db, `chat:${session.user.id}`, limits);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many chat requests. Please wait a moment and try again.",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const requestedModelId = nonEmptyString(body.modelId) ?? DEFAULT_MODEL_ID;
  const modelId = (await isModelEnabled(db, requestedModelId, "chat"))
    ? requestedModelId
    : await resolveModelForPurpose(db, "chat");
  const now = new Date();
  const userTimeZone = normalizeUserTimeZone(body.timeZone);
  const runId = randomUUID();
  const requestMessageId = randomUUID();
  const message = formatArtifactReviewMessage({
    filename: access.artifact.filename,
    versionNumber: access.artifact.versionNumber,
    commentCount: selections.length,
  });
  let reviewRequest: StoredArtifactReviewRequest;

  try {
    reviewRequest = await db.transaction(async (tx) => {
      const latestRows = await tx
        .select({
          id: workspaceArtifacts.id,
          versionNumber: workspaceArtifacts.versionNumber,
        })
        .from(workspaceArtifacts)
        .where(
          and(
            eq(workspaceArtifacts.userId, access.artifact.userId),
            eq(
              workspaceArtifacts.artifactGroupId,
              access.artifact.artifactGroupId,
            ),
          ),
        )
        .orderBy(desc(workspaceArtifacts.versionNumber))
        .limit(1)
        .for("update");
      if (latestRows[0]?.id !== access.artifact.id) {
        throw new ArtifactReviewRequestConflict("artifact_stale_base");
      }

      const selectedRows = await tx
        .select()
        .from(artifactReviewComments)
        .where(
          and(
            inArray(
              artifactReviewComments.id,
              selections.map((selection) => selection.id),
            ),
            eq(artifactReviewComments.artifactId, access.artifact.id),
            eq(artifactReviewComments.status, "open"),
          ),
        )
        .for("update");
      if (selectedRows.length !== selections.length) {
        throw new ArtifactReviewRequestConflict("comment_changed");
      }
      const rowsById = new Map(selectedRows.map((row) => [row.id, row]));
      const selected = selections.map((selection) => {
        const row = rowsById.get(selection.id);
        const anchor = row ? parseArtifactReviewAnchor(row.anchor) : null;
        if (!row || row.revision !== selection.revision || !anchor) {
          throw new ArtifactReviewRequestConflict("comment_changed");
        }
        return { row, anchor };
      });

      const stored: StoredArtifactReviewRequest = {
        runId,
        sourceArtifactId: access.artifact.id,
        sourceArtifactGroupId: access.artifact.artifactGroupId,
        sourceArtifactVersionNumber: access.artifact.versionNumber,
        sourceArtifactFilename: access.artifact.filename,
        sourceThreadId: thread.id,
        requestMessageId,
        requestedAt: now.toISOString(),
        requestedByUserId: session.user.id,
        comments: selected.map(({ row, anchor }) => ({
          id: row.id,
          revision: row.revision + 1,
          body: row.body,
          anchor,
          authorDisplayName: row.authorDisplayName,
        })),
      };

      await tx.insert(chatMessages).values({
        id: requestMessageId,
        threadId: thread.id,
        role: "user",
        content: message,
      });
      await tx.insert(runs).values({
        id: runId,
        userId: session.user.id,
        threadId: thread.id,
        skillSlug: "chat-turn",
        triggerType: "artifact_review",
        status: "queued",
        modelId,
        inputs: {
          prompt: message,
          threadId: thread.id,
          userMessageId: requestMessageId,
          requestedByUserId: session.user.id,
          autonomyPreset: resolveAutonomyPreset("artifact_review").name,
          executionMode: "local",
          modelOverride: false,
          runtimeRoute: ARTIFACT_REVIEW_ROUTE,
          runBudget,
          artifactContextTarget: toWorkspaceArtifactVersionTarget(
            access.artifact,
          ),
          artifactReviewRequest: stored,
          ...(userTimeZone ? { userTimeZone } : {}),
        },
        attemptCount: 0,
        updatedAt: now,
      });

      for (const { row } of selected) {
        const reserved = await tx
          .update(artifactReviewComments)
          .set({
            status: "addressing",
            revision: row.revision + 1,
            addressingRunId: runId,
            updatedAt: now,
          })
          .where(
            and(
              eq(artifactReviewComments.id, row.id),
              eq(artifactReviewComments.status, "open"),
              eq(artifactReviewComments.revision, row.revision),
            ),
          )
          .returning({ id: artifactReviewComments.id });
        if (!reserved[0]) {
          throw new ArtifactReviewRequestConflict("comment_changed");
        }
      }
      await tx
        .update(chatThreads)
        .set({
          updatedAt: now,
          previewSummary: null,
          previewSummaryUpdatedAt: null,
        })
        .where(eq(chatThreads.id, thread.id));
      await tx.insert(auditLog).values({
        actorUserId: session.user.id,
        actionType: "artifact_review_address_requested",
        status: "succeeded",
        provider: "ai-hub",
        toolName: "artifact_review",
        chatThreadId: thread.id,
        chatMessageId: requestMessageId,
        runId,
        input: {
          sourceArtifactId: access.artifact.id,
          commentIds: stored.comments.map((comment) => comment.id),
        },
        metadata: {
          sourceArtifactVersionNumber: access.artifact.versionNumber,
          selectedCommentCount: stored.comments.length,
          transition: "open_to_addressing",
          runBudget: runBudgetEnvelopeForEvent(runBudget),
        },
        startedAt: now,
        completedAt: now,
      });
      return stored;
    });
  } catch (error) {
    if (error instanceof ArtifactReviewRequestConflict) {
      return NextResponse.json(
        {
          error: error.code,
          message:
            error.code === "artifact_stale_base"
              ? "A newer artifact version exists. Compare it before addressing these comments."
              : "One or more comments changed. Reload the review before trying again.",
        },
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
      label: "Queued selected artifact review comments",
      metadata: {
        threadId: thread.id,
        modelId,
        userMessageId: requestMessageId,
        runtimeRoute: ARTIFACT_REVIEW_ROUTE,
        sourceArtifactId: access.artifact.id,
        commentIds: reviewRequest.comments.map((comment) => comment.id),
        runBudget: runBudgetEnvelopeForEvent(runBudget),
      },
      occurredAt: now,
    });
  } catch (error) {
    process.stderr.write(
      `[artifact-review-run-event-error] ${JSON.stringify({
        runId,
        threadId: thread.id,
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  startInProcessChatRunWorker({ db, runId });
  return queuedReviewResponse({
    threadId: thread.id,
    runId,
    userMessageId: requestMessageId,
    modelId,
  });
}

function queuedReviewResponse({
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
          runtimeRoute: ARTIFACT_REVIEW_ROUTE,
        },
        {
          type: "queued",
          threadId,
          runId,
          status: "Addressing selected review comments",
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
