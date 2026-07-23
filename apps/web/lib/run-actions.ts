import type { SessionUser } from "@ai-workspace/auth";
import {
  auditLog,
  type Database,
  runs,
  type Run,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";

const WORKER_TRIGGER_TYPES = new Set([
  "skill",
  "scheduled",
  "github_event",
  "skill_retry",
]);

function isWorkerExecutableRun(
  run: Pick<Run, "skillSlug" | "triggerType">,
): boolean {
  return (
    run.skillSlug === "chat-turn" || WORKER_TRIGGER_TYPES.has(run.triggerType)
  );
}
import { parseChatExecutionMode } from "@/lib/chat-execution-mode";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import { appendRunEventWithNextSequence } from "@/lib/run-events";
import {
  proposalIterationFromRunInputs,
  releaseProposalIteration,
} from "@/lib/proposal-iterations";

type RunActionResult =
  | { ok: true; run: Pick<Run, "id" | "status"> }
  | { ok: false; status: number; error: string; message: string };

interface ChatRunInputs {
  prompt?: string;
  threadId?: string;
  userMessageId?: string;
  retryOfRunId?: string;
  executionMode?: "local";
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
  if (!isWorkerExecutableRun(run)) {
    return {
      ok: false,
      status: 400,
      error: "unsupported_run_type",
      message: "Only chat and skill runs can be canceled from this endpoint.",
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

  const now = new Date();
  const error = "Canceled by user.";
  const cancellationMetadata =
    run.status === "running"
      ? {
          cancellationPath: "worker_poll_then_runtime_abort",
          runtimeRequestAbortExpected: true,
          providerSessionStopAttempted: false,
        }
      : {
          cancellationPath: "queue_state_only",
          runtimeRequestAbortExpected: false,
          providerSessionStopAttempted: false,
        };
  const rows = await db
    .update(runs)
    .set({
      status: "canceled",
      error,
      workerId: null,
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(runs.id, run.id))
    .returning({ id: runs.id, status: runs.status });

  const proposalIteration = proposalIterationFromRunInputs(run.inputs);
  if (proposalIteration) {
    try {
      await releaseProposalIteration({
        db,
        iteration: proposalIteration,
        error,
        completedAt: now,
      });
    } catch (releaseError) {
      process.stderr.write(
        `[proposal-iteration-release-error] ${JSON.stringify({
          runId: run.id,
          message:
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError),
        })}\n`,
      );
    }
  }

  await appendRunEventWithNextSequence({
    db,
    runId: run.id,
    eventType: "run_canceled",
    status: "failed",
    label: "Run canceled",
    error,
    metadata: {
      actorUserId: actor.id,
      ...cancellationMetadata,
    },
  });
  await db.insert(auditLog).values({
    actorUserId: actor.id,
    actionType: "run_cancel",
    status: "succeeded",
    provider: "ai-hub",
    toolName: "run_cancel",
    chatThreadId: run.threadId,
    runId: run.id,
    input: { runId: run.id },
    error: null,
    metadata: { previousStatus: run.status, ...cancellationMetadata },
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
  if (!isWorkerExecutableRun(run)) {
    return {
      ok: false,
      status: 400,
      error: "unsupported_run_type",
      message: "Only chat and skill runs can be retried from this endpoint.",
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
  if (proposalIterationFromRunInputs(run.inputs)) {
    return {
      ok: false,
      status: 409,
      error: "proposal_iteration_retry_from_card",
      message:
        "The original proposal is pending again. Add feedback from its Iterate action to retry.",
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
    .insert(runs)
    .values({
      userId: run.userId,
      threadId: inputs.threadId,
      skillId: run.skillId,
      skillSlug: run.skillSlug,
      scheduleId: run.scheduleId,
      eventTriggerId: run.eventTriggerId,
      eventDeliveryId: null,
      triggerType: run.skillSlug === "chat-turn" ? "chat_retry" : "skill_retry",
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
    .returning({ id: runs.id, status: runs.status });
  const nextRun = rows[0]!;

  await appendRunEventWithNextSequence({
    db,
    runId: nextRun.id,
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
    runId: nextRun.id,
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
  if (!isWorkerExecutableRun(run)) {
    return {
      ok: false,
      status: 400,
      error: "unsupported_run_type",
      message: "Only chat and skill runs can be resumed from this endpoint.",
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
    .update(runs)
    .set({
      leaseExpiresAt: new Date(0),
      updatedAt: now,
    })
    .where(eq(runs.id, run.id));
  await appendRunEventWithNextSequence({
    db,
    runId: run.id,
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
    runId: run.id,
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
): Promise<Run | null> {
  const rows = await db
    .select()
    .from(runs)
    .where(
      actor.role === "admin"
        ? eq(runs.id, runId)
        : and(eq(runs.id, runId), eq(runs.userId, actor.id)),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
