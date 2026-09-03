import type { SessionUser } from "@ai-workspace/auth";
import {
  auditLog,
  type Database,
  runs,
  type Run,
  toolApprovalRequests,
} from "@ai-workspace/db";
import { and, eq, inArray } from "drizzle-orm";

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
import {
  artifactReviewRequestFromRunInputs,
  releaseArtifactReviewRequest,
} from "@/lib/artifact-review";
import { resolveAutonomyPreset } from "@/lib/autonomy-presets";
import {
  resolveRetryRunBudget,
  runBudgetEnvelopeForEvent,
  runBudgetLaneFromRoute,
} from "@/lib/run-budget-policy";

type RunActionResult =
  | { ok: true; run: Pick<Run, "id" | "status"> }
  | { ok: false; status: number; error: string; message: string };

export type CancelRunOutcome =
  | "canceled"
  | "already_canceled"
  | "already_terminal"
  | "result_committed";

type CancelRunResult =
  | { ok: true; outcome: CancelRunOutcome; run: Pick<Run, "id" | "status"> }
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
}): Promise<CancelRunResult> {
  const now = new Date();
  const error = "Canceled by user.";
  // One FOR UPDATE transaction so a cancel serializes against
  // persistAssistantMessageOnce: it can no longer land between the status
  // read and the canceled write and disown a committed answer (#655).
  const decision = await db.transaction(
    async (
      tx,
    ): Promise<
      | { kind: "rejected"; result: CancelRunResult }
      | { kind: "kept"; outcome: CancelRunOutcome; run: Run }
      | { kind: "canceled"; run: Run; updated: Pick<Run, "id" | "status"> }
    > => {
      const rows = await tx
        .select()
        .from(runs)
        .where(authorizedRunScope(actor, runId))
        .limit(1)
        .for("update");
      const run = rows[0];
      if (!run) {
        return { kind: "rejected", result: notFound() };
      }
      if (!isWorkerExecutableRun(run)) {
        return {
          kind: "rejected",
          result: {
            ok: false,
            status: 400,
            error: "unsupported_run_type",
            message:
              "Only chat and skill runs can be canceled from this endpoint.",
          },
        };
      }
      if (run.status === "canceled") {
        return { kind: "kept", outcome: "already_canceled", run };
      }
      if (
        run.status !== "queued" &&
        run.status !== "running" &&
        run.status !== "waiting_for_approval"
      ) {
        return { kind: "kept", outcome: "already_terminal", run };
      }
      const committedMessageId = isRecord(run.outputs)
        ? run.outputs.assistantMessageId
        : undefined;
      if (typeof committedMessageId === "string" && committedMessageId.length > 0) {
        // The durable assistant answer already committed; the worker's fenced
        // terminal write will finish the run, so keep the result instead.
        return { kind: "kept", outcome: "result_committed", run };
      }
      const updated = await tx
        .update(runs)
        .set({
          status: "canceled",
          error,
          workerId: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        // Defense in depth: the lock already pinned the status, but never let
        // this write stomp a terminal row even if the guards above drift.
        .where(
          and(
            eq(runs.id, run.id),
            inArray(runs.status, [
              "queued",
              "running",
              "waiting_for_approval",
            ]),
          ),
        )
        .returning({ id: runs.id, status: runs.status });
      await tx
        .update(toolApprovalRequests)
        .set({ status: "expired", decidedAt: now, updatedAt: now })
        .where(
          and(
            eq(toolApprovalRequests.runId, run.id),
            eq(toolApprovalRequests.status, "pending"),
          ),
        );
      return { kind: "canceled", run, updated: updated[0]! };
    },
  );

  if (decision.kind === "rejected") {
    return decision.result;
  }
  if (decision.kind === "kept") {
    return {
      ok: true,
      outcome: decision.outcome,
      run: { id: decision.run.id, status: decision.run.status },
    };
  }

  const run = decision.run;
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
  const artifactReviewRequest = artifactReviewRequestFromRunInputs(run.inputs);
  if (artifactReviewRequest?.runId === run.id) {
    try {
      await releaseArtifactReviewRequest({
        db,
        request: artifactReviewRequest,
        error,
        completedAt: now,
      });
    } catch (releaseError) {
      process.stderr.write(
        `[artifact-review-release-error] ${JSON.stringify({
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

  return { ok: true, outcome: "canceled", run: decision.updated };
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
  if (artifactReviewRequestFromRunInputs(run.inputs)) {
    return {
      ok: false,
      status: 409,
      error: "artifact_review_retry_from_review",
      message:
        "The selected comments are open again. Retry from Address with Comparative after reloading the review.",
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
  const retryTriggerType =
    run.skillSlug === "chat-turn" ? "chat_retry" : "skill_retry";
  const runBudget = resolveRetryRunBudget({
    source: inputs.runBudget,
    lane: runBudgetLaneFromRoute(inputs.runtimeRoute),
    triggerType: retryTriggerType,
  });
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
      triggerType: retryTriggerType,
      status: "queued",
      modelId: run.modelId,
      inputs: {
        ...inputs,
        autonomyPreset: resolveAutonomyPreset(retryTriggerType).name,
        retryOfRunId: run.id,
        retryOfStatus: run.status,
        retryOfError: run.error,
        retryRequestedAt: now.toISOString(),
        retryRequestedByUserId: actor.id,
        runBudget,
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
      runBudget: runBudgetEnvelopeForEvent(runBudget),
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
    metadata: {
      sourceStatus: run.status,
      runBudget: runBudgetEnvelopeForEvent(runBudget),
    },
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

function authorizedRunScope(actor: SessionUser, runId: string) {
  return actor.role === "admin"
    ? eq(runs.id, runId)
    : and(eq(runs.id, runId), eq(runs.userId, actor.id));
}

async function findAuthorizedRun(
  db: Database,
  actor: SessionUser,
  runId: string,
): Promise<Run | null> {
  const rows = await db
    .select()
    .from(runs)
    .where(authorizedRunScope(actor, runId))
    .limit(1);
  return rows[0] ?? null;
}

function notFound(): {
  ok: false;
  status: number;
  error: string;
  message: string;
} {
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
