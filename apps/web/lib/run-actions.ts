import type { SessionUser } from "@ai-workspace/auth";
import { cancelCursorCloudRun } from "@ai-workspace/cursor-runtime";
import {
  auditLog,
  type Database,
  recipeRuns,
  type RecipeRun,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { parseChatExecutionMode } from "@/lib/chat-execution-mode";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import { appendRunEventWithNextSequence } from "@/lib/run-events";

type RunActionResult =
  | { ok: true; run: Pick<RecipeRun, "id" | "status"> }
  | { ok: false; status: number; error: string; message: string };

interface ChatRunInputs {
  prompt?: string;
  threadId?: string;
  userMessageId?: string;
  retryOfRunId?: string;
  executionMode?: "local" | "cloud";
  [key: string]: unknown;
}

interface ChatRunOutputs {
  providerRun?: {
    providerAgentId?: string;
    providerRunId?: string;
    executionMode?: string;
  };
  [key: string]: unknown;
}

export async function cancelRun({
  db,
  actor,
  runId,
}: {
  db: Database;
  actor: SessionUser;
  runId: string;
}): Promise<RunActionResult> {
  const run = await findAuthorizedRun(db, actor, runId);
  if (!run) {
    return notFound();
  }
  if (run.recipeSlug !== "chat-turn") {
    return {
      ok: false,
      status: 400,
      error: "unsupported_run_type",
      message: "Only chat runs can be canceled from this endpoint.",
    };
  }
  if (run.status !== "queued" && run.status !== "running") {
    return {
      ok: false,
      status: 409,
      error: "run_not_cancelable",
      message: "Only queued or running runs can be canceled.",
    };
  }

  const output = parseOutputs(run.outputs);
  let providerCancelError: string | null = null;
  if (
    output.providerRun?.executionMode === "cloud" &&
    output.providerRun.providerAgentId &&
    output.providerRun.providerRunId
  ) {
    try {
      await cancelCursorCloudRun({
        apiKey: process.env.CURSOR_API_KEY,
        providerAgentId: output.providerRun.providerAgentId,
        providerRunId: output.providerRun.providerRunId,
      });
    } catch (err) {
      providerCancelError = err instanceof Error ? err.message : String(err);
    }
  }

  const now = new Date();
  const error = providerCancelError
    ? `Canceled in AI Hub. Provider cancel returned: ${providerCancelError}`
    : "Canceled by user.";
  const rows = await db
    .update(recipeRuns)
    .set({
      status: "canceled",
      error,
      workerId: null,
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(recipeRuns.id, run.id))
    .returning({ id: recipeRuns.id, status: recipeRuns.status });

  await appendRunEventWithNextSequence({
    db,
    recipeRunId: run.id,
    eventType: "run_canceled",
    status: "failed",
    label: "Run canceled",
    error,
    metadata: {
      actorUserId: actor.id,
      providerCancelAttempted: output.providerRun?.executionMode === "cloud",
      providerCancelSucceeded:
        output.providerRun?.executionMode === "cloud"
          ? providerCancelError === null
          : null,
    },
  });
  await db.insert(auditLog).values({
    actorUserId: actor.id,
    actionType: "run_cancel",
    status: providerCancelError ? "failed" : "succeeded",
    provider: "ai-hub",
    toolName: "run_cancel",
    chatThreadId: run.threadId,
    recipeRunId: run.id,
    input: { runId: run.id },
    error: providerCancelError,
    metadata: { previousStatus: run.status },
    startedAt: now,
    completedAt: now,
  });

  return { ok: true, run: rows[0]! };
}

export async function retryChatRun({
  db,
  actor,
  runId,
}: {
  db: Database;
  actor: SessionUser;
  runId: string;
}): Promise<RunActionResult> {
  const run = await findAuthorizedRun(db, actor, runId);
  if (!run) return notFound();
  if (run.recipeSlug !== "chat-turn") {
    return {
      ok: false,
      status: 400,
      error: "unsupported_run_type",
      message: "Only chat runs can be retried from this endpoint.",
    };
  }
  if (run.status !== "failed" && run.status !== "canceled") {
    return {
      ok: false,
      status: 409,
      error: "run_not_retryable",
      message: "Only failed or canceled chat runs can be retried.",
    };
  }

  const inputs = parseInputs(run.inputs);
  if (!inputs.prompt || !inputs.threadId || !inputs.userMessageId) {
    return {
      ok: false,
      status: 400,
      error: "missing_retry_context",
      message: "The source run does not have enough stored context to retry.",
    };
  }

  const now = new Date();
  const rows = await db
    .insert(recipeRuns)
    .values({
      userId: run.userId,
      threadId: inputs.threadId,
      recipeSlug: "chat-turn",
      triggerType: "chat_retry",
      status: "queued",
      modelId: run.modelId,
      inputs: {
        ...inputs,
        retryOfRunId: run.id,
        retryOfStatus: run.status,
        retryOfError: run.error,
        retryRequestedAt: now.toISOString(),
        retryRequestedByUserId: actor.id,
      },
      updatedAt: now,
    })
    .returning({ id: recipeRuns.id, status: recipeRuns.status });
  const nextRun = rows[0]!;

  await appendRunEventWithNextSequence({
    db,
    recipeRunId: nextRun.id,
    eventType: "run_queued",
    status: "pending",
    label: "Queued retry",
    metadata: {
      retryOfRunId: run.id,
      threadId: inputs.threadId,
      userMessageId: inputs.userMessageId,
      modelId: run.modelId,
    },
  });
  await db.insert(auditLog).values({
    actorUserId: actor.id,
    actionType: "run_retry",
    status: "succeeded",
    provider: "ai-hub",
    toolName: "run_retry",
    chatThreadId: inputs.threadId,
    recipeRunId: nextRun.id,
    input: { retryOfRunId: run.id },
    metadata: { sourceStatus: run.status },
    startedAt: now,
    completedAt: now,
  });

  startInProcessChatRunWorker({ db, runId: nextRun.id });
  return { ok: true, run: nextRun };
}

export async function resumeChatRun({
  db,
  actor,
  runId,
}: {
  db: Database;
  actor: SessionUser;
  runId: string;
}): Promise<RunActionResult> {
  const run = await findAuthorizedRun(db, actor, runId);
  if (!run) return notFound();
  if (run.recipeSlug !== "chat-turn") {
    return {
      ok: false,
      status: 400,
      error: "unsupported_run_type",
      message: "Only chat runs can be resumed from this endpoint.",
    };
  }
  if (run.status !== "queued" && run.status !== "running") {
    return {
      ok: false,
      status: 409,
      error: "run_not_resumable",
      message: "Only queued or running chat runs can be resumed.",
    };
  }

  const now = new Date();
  await db
    .update(recipeRuns)
    .set({
      leaseExpiresAt: new Date(0),
      updatedAt: now,
    })
    .where(eq(recipeRuns.id, run.id));
  await appendRunEventWithNextSequence({
    db,
    recipeRunId: run.id,
    eventType: "run_resume_requested",
    status: "pending",
    label: "Resume requested",
    metadata: { actorUserId: actor.id },
  });
  await db.insert(auditLog).values({
    actorUserId: actor.id,
    actionType: "run_resume",
    status: "succeeded",
    provider: "ai-hub",
    toolName: "run_resume",
    chatThreadId: run.threadId,
    recipeRunId: run.id,
    input: { runId: run.id },
    metadata: { previousStatus: run.status },
    startedAt: now,
    completedAt: now,
  });

  startInProcessChatRunWorker({ db, runId: run.id });
  return { ok: true, run: { id: run.id, status: run.status } };
}

async function findAuthorizedRun(
  db: Database,
  actor: SessionUser,
  runId: string,
): Promise<RecipeRun | null> {
  const rows = await db
    .select()
    .from(recipeRuns)
    .where(
      actor.role === "admin"
        ? eq(recipeRuns.id, runId)
        : and(eq(recipeRuns.id, runId), eq(recipeRuns.userId, actor.id)),
    )
    .limit(1);
  return rows[0] ?? null;
}

function notFound(): RunActionResult {
  return {
    ok: false,
    status: 404,
    error: "run_not_found",
    message: "The run was not found.",
  };
}

function parseInputs(value: unknown): ChatRunInputs {
  if (!isRecord(value)) return {};
  return {
    ...value,
    executionMode: parseChatExecutionMode(value.executionMode),
  } as ChatRunInputs;
}

function parseOutputs(value: unknown): ChatRunOutputs {
  return isRecord(value) ? (value as ChatRunOutputs) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
