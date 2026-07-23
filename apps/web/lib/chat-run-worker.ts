import { normalizeUserTimeZone } from "@ai-workspace/agent";
import { getRuntime } from "@ai-workspace/agent-runtime";
import { chatThreads, type Database, runs, type Run } from "@ai-workspace/db";
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { ChatContextUploadedFile } from "@/lib/chat-context-pack";
import {
  parseChatExecutionMode,
  type ChatExecutionMode,
} from "@/lib/chat-execution-mode";
import type { ChatRoutingMode, ChatRuntimeRoute } from "@/lib/chat-routing";
import { parseWorkspaceArtifactVersionTarget } from "@/lib/artifact-revisions";
import type { PinnedActiveSkill } from "@/lib/pinned-context";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { resolveModelForPurpose } from "@/lib/model-registry";
import { createProactiveRunNotification } from "@/lib/notifications";
import {
  executeChatTurn,
  isRunCanceled,
  numberFromEnv,
} from "@/lib/execute-chat-turn";

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RUNTIME_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** #448: how many claimed runs a single worker executes concurrently. */
const DEFAULT_RUN_CONCURRENCY = 3;
/** How long an inline run may go without a heartbeat before it is orphaned. */
const DEFAULT_ORPHAN_MAX_AGE_MS = 15 * 60 * 1000;
const ORPHAN_SWEEP_INTERVAL_MS = 60_000;

type ChatRunWorkerStatus = "idle" | "running" | "succeeded" | "failed";

interface ChatRunInputs {
  prompt: string;
  threadId: string;
  userMessageId: string;
  executionMode: ChatExecutionMode;
  /** Skill runs restrict MCP mounting to their declared providers. */
  requestedProviders?: string[];
  activeSkillPrompt?: PinnedActiveSkill;
  uploadedFiles?: ChatContextUploadedFile[];
  artifactContextTarget?: unknown;
  separateFromArtifact?: unknown;
  [key: string]: unknown;
}

/**
 * Runs this worker may claim: chat turns (identified by the historical
 * `skill_slug = "chat-turn"` marker) plus skill, scheduled, and event-triggered
 * runs (identified by trigger type so any skill slug works). Inputs satisfy
 * the same {prompt, threadId, userMessageId} contract.
 */
const WORKER_TRIGGER_TYPES = [
  "skill",
  "scheduled",
  "github_event",
  "skill_retry",
];
const WORKER_TRIGGER_TYPE_SET = new Set<string>(WORKER_TRIGGER_TYPES);

function claimableRunCondition() {
  return or(
    eq(runs.skillSlug, "chat-turn"),
    inArray(runs.triggerType, WORKER_TRIGGER_TYPES),
  );
}

interface ProcessChatRunInput {
  db: Database;
  runId?: string;
  workerId?: string;
  signal?: AbortSignal;
}

interface ChatRunWorkerLoopInput {
  db: Database;
  workerId?: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

const activeInProcessRuns = new Set<string>();

export function startInProcessChatRunWorker({
  db,
  runId,
}: {
  db: Database;
  runId: string;
}): void {
  if (process.env.CHAT_RUN_IN_PROCESS_WORKER === "0") return;
  if (activeInProcessRuns.has(runId)) return;

  activeInProcessRuns.add(runId);
  setTimeout(() => {
    void processQueuedChatRun({
      db,
      runId,
      workerId: `web-${process.pid}`,
    })
      .catch((err) => {
        process.stderr.write(
          `[chat-run-worker-error] ${JSON.stringify({
            runId,
            message: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
      })
      .finally(() => {
        activeInProcessRuns.delete(runId);
      });
  }, 0).unref?.();
}

export async function runChatRunWorkerLoop({
  db,
  workerId = `worker-${process.pid}`,
  pollIntervalMs = numberFromEnv("CHAT_RUN_WORKER_POLL_INTERVAL_MS") ??
    DEFAULT_POLL_INTERVAL_MS,
  signal,
}: ChatRunWorkerLoopInput): Promise<void> {
  // #448: bounded per-worker concurrency. Claims stay sequential; executions
  // run concurrently up to the cap. The lease protocol is multi-claimant-safe
  // (#443 fencing + the run_events (run_id, sequence) unique index), and each
  // in-flight run heartbeats its own lease from executeClaimedChatRun.
  const concurrency = Math.max(
    1,
    Math.floor(numberFromEnv("WORKER_RUN_CONCURRENCY") ?? DEFAULT_RUN_CONCURRENCY),
  );
  const inFlight = new Set<Promise<void>>();
  let lastSweepAt = 0;
  while (!signal?.aborted) {
    // #443: reap stranded inline runs (no lease, dead heartbeat) so a web
    // process crash never leaves a thread showing "Working…" forever.
    if (Date.now() - lastSweepAt >= ORPHAN_SWEEP_INTERVAL_MS) {
      lastSweepAt = Date.now();
      try {
        await reapOrphanedRuns({ db });
      } catch (err) {
        process.stderr.write(
          `[chat-run-orphan-sweep-error] ${JSON.stringify({
            message: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
      }
    }
    const claimed =
      inFlight.size < concurrency ? await claimChatRun({ db, workerId }) : null;
    if (claimed) {
      // A rejected task (bookkeeping DB failure) must not tear down the other
      // in-flight runs, so log it here instead of letting it escape the loop.
      const task: Promise<void> = runClaimedChatRun({
        db,
        run: claimed,
        workerId,
        signal,
      })
        .then(() => undefined)
        .catch((err: unknown) => {
          process.stderr.write(
            `[chat-run-worker-error] ${JSON.stringify({
              runId: claimed.id,
              threadId: claimed.threadId,
              message: err instanceof Error ? err.message : String(err),
            })}\n`,
          );
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
      // Another slot may still be free — try to claim again immediately.
      continue;
    }
    // Idle or at capacity: wake on the next poll tick or a finished run.
    await Promise.race([delay(pollIntervalMs, signal), ...inFlight]);
  }
  // Graceful shutdown: in-flight runs observe the abort signal; wait for
  // their terminal writes before returning.
  await Promise.all(inFlight);
}

/**
 * #443: fail `running` runs that have no lease and a stale heartbeat. Worker
 * runs always carry a lease (expired leases are re-claimable instead), and
 * the sweep is scoped to `skill_slug = "chat-turn"` — the inline chat lane it
 * owns — so it cannot reach other inline lanes (e.g. the developer-briefing
 * workflow, which also inserts `running` runs without a lease or heartbeat).
 * Within the chat lane the inline shell heartbeats `lastHeartbeatAt` while
 * streaming and its crash handler marks clean failures directly, leaving only
 * true orphans here.
 */
export async function reapOrphanedRuns({
  db,
  maxAgeMs = numberFromEnv("CHAT_RUN_ORPHAN_MAX_AGE_MS") ??
    DEFAULT_ORPHAN_MAX_AGE_MS,
}: {
  db: Database;
  maxAgeMs?: number;
}): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const reaped = await db
    .update(runs)
    .set({
      status: "failed",
      error:
        "The run was orphaned: its process stopped before finishing the turn.",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        // Scope to the inline chat lane this reaper owns. Other inline lanes
        // (developer-briefing) also run leaseless + heartbeat-less and would
        // otherwise be falsely reaped mid-turn (#443 review).
        eq(runs.skillSlug, "chat-turn"),
        eq(runs.status, "running"),
        isNull(runs.leaseExpiresAt),
        or(
          lt(runs.lastHeartbeatAt, cutoff),
          and(isNull(runs.lastHeartbeatAt), lt(runs.updatedAt, cutoff)),
        ),
      ),
    )
    .returning();

  for (const run of reaped) {
    await appendRunEventBestEffort("chat-run-event-error", {
      db,
      runId: run.id,
      eventType: "run_failed",
      status: "failed",
      label: "Run orphaned by a stopped process",
      error: run.error,
    });
    await createProactiveRunNotification(db, run, "failed", run.threadId);
  }
  return reaped.length;
}

export async function processQueuedChatRun({
  db,
  runId,
  workerId = `worker-${process.pid}`,
  signal,
}: ProcessChatRunInput): Promise<{
  status: ChatRunWorkerStatus;
  runId?: string;
}> {
  const claimed = await claimChatRun({ db, runId, workerId });
  if (!claimed) return { status: "idle" };
  return runClaimedChatRun({ db, run: claimed, workerId, signal });
}

async function runClaimedChatRun({
  db,
  run,
  workerId,
  signal,
}: {
  db: Database;
  run: Run;
  workerId: string;
  signal?: AbortSignal;
}): Promise<{ status: ChatRunWorkerStatus; runId: string }> {
  try {
    await executeClaimedChatRun({ db, run, workerId, signal });
    return { status: "succeeded", runId: run.id };
  } catch (err) {
    if (await isRunCanceled(db, run.id)) {
      return { status: "succeeded", runId: run.id };
    }
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(db, run, message, workerId);
    process.stderr.write(
      `[chat-run-worker-error] ${JSON.stringify({
        runId: run.id,
        threadId: run.threadId,
        message,
      })}\n`,
    );
    return { status: "failed", runId: run.id };
  }
}

async function claimChatRun({
  db,
  runId,
  workerId,
}: {
  db: Database;
  runId?: string;
  workerId: string;
}): Promise<Run | null> {
  const id = runId ?? (await findNextClaimableRunId(db));
  if (!id) return null;

  const now = new Date();
  const leaseMs = numberFromEnv("CHAT_RUN_WORKER_LEASE_MS") ?? DEFAULT_LEASE_MS;
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const rows = await db
    .update(runs)
    .set({
      status: "running",
      workerId,
      leaseExpiresAt,
      lastHeartbeatAt: now,
      attemptCount: sql`${runs.attemptCount} + 1`,
      startedAt: sql`coalesce(${runs.startedAt}, now())`,
      updatedAt: now,
    })
    .where(
      and(
        eq(runs.id, id),
        claimableRunCondition(),
        or(
          eq(runs.status, "queued"),
          and(eq(runs.status, "running"), lt(runs.leaseExpiresAt, now)),
        ),
      ),
    )
    .returning();

  return rows[0] ?? null;
}

async function findNextClaimableRunId(db: Database): Promise<string | null> {
  const now = new Date();
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        claimableRunCondition(),
        or(
          eq(runs.status, "queued"),
          and(eq(runs.status, "running"), lt(runs.leaseExpiresAt, now)),
        ),
      ),
    )
    .orderBy(asc(runs.createdAt))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Worker-lane shell around the shared turn pipeline (#442): claims are done
 * by the caller; this parses stored inputs, re-validates the model against
 * the registry at turn time (#300 — queued runs no longer trust a stale
 * `run.modelId` verbatim), and wraps `executeChatTurn` with the lane's
 * timeout, lease heartbeat, and shutdown-signal wiring.
 */
async function executeClaimedChatRun({
  db,
  run,
  workerId,
  signal,
}: {
  db: Database;
  run: Run;
  workerId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const inputs = parseChatRunInputs(run.inputs);
  const runtimeRoute =
    parseStoredRuntimeRoute(inputs.runtimeRoute) ??
    defaultWorkerRuntimeRoute(inputs);

  await appendRunEventBestEffort("chat-run-event-error", {
    db,
    runId: run.id,
    eventType: "worker_claimed",
    status: "pending",
    label: "Background worker claimed the run",
    metadata: { workerId },
  });

  const runtime = getRuntime({ runtime: workerRuntimeName() });
  const threadRows = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.id, inputs.threadId))
    .limit(1);
  const thread = threadRows[0];
  if (!thread) throw new Error("Chat thread was not found for queued run.");

  const modelId = await resolveModelForPurpose(db, runtimeRoute.lane, {
    preferred: run.modelId,
  });

  const runtimeAbort = new AbortController();
  const externalAbort = () => runtimeAbort.abort();
  signal?.addEventListener("abort", externalAbort, { once: true });

  const timeoutMs =
    numberFromEnv("CHAT_WORKER_RUNTIME_TIMEOUT_MS") ??
    DEFAULT_RUNTIME_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    runtimeAbort.abort();
    process.stderr.write(
      `[chat-run-worker-timeout] ${JSON.stringify({
        runId: run.id,
        threadId: thread.id,
        timeoutMs,
      })}\n`,
    );
  }, timeoutMs);
  timeout.unref?.();

  const heartbeat = setInterval(
    () => {
      void heartbeatRunLease(db, run.id, workerId)
        .then((held) => {
          // #443: another worker owns the run now (expired-lease reclaim or
          // admin resume). Stop executing instead of double-running the turn.
          if (!held) {
            process.stderr.write(
              `[chat-run-lease-lost] ${JSON.stringify({
                runId: run.id,
                workerId,
              })}\n`,
            );
            clearInterval(heartbeat);
            runtimeAbort.abort();
          }
        })
        .catch((err) => {
          process.stderr.write(
            `[chat-run-heartbeat-error] ${JSON.stringify({
              runId: run.id,
              message: err instanceof Error ? err.message : String(err),
            })}\n`,
          );
        });
    },
    Math.max(
      15_000,
      Math.floor(
        (numberFromEnv("CHAT_RUN_WORKER_LEASE_MS") ?? DEFAULT_LEASE_MS) / 3,
      ),
    ),
  );
  heartbeat.unref?.();

  try {
    await executeChatTurn({
      db,
      runId: run.id,
      userId: run.userId,
      thread,
      prompt: inputs.prompt,
      userMessageId: inputs.userMessageId,
      route: runtimeRoute,
      runtime,
      runtimeAbort,
      modelId,
      requestedProviders: inputs.requestedProviders,
      activeSkillPrompt: sanitizeActiveSkillPrompt(inputs.activeSkillPrompt),
      uploadedFiles: sanitizeUploadedFiles(inputs.uploadedFiles),
      // #432: only chat turns ever store a zone; scheduled/skill runs have
      // none and stay UTC-only. Re-validated because stored JSON is not a
      // trusted prompt source either.
      userTimeZone: normalizeUserTimeZone(inputs.userTimeZone),
      suppressedSkillIds: activatedSkillIdsFromInputs(run.inputs),
      interactive: run.triggerType === "chat",
      lane: {
        kind: "worker",
        run,
        workerId,
        storedInputs: inputs,
        executionMode: inputs.executionMode,
        timeoutMs,
        preferArtifactFallback: WORKER_TRIGGER_TYPE_SET.has(run.triggerType),
        storedArtifactTarget: parseWorkspaceArtifactVersionTarget(
          inputs.artifactContextTarget,
        ),
        storedSeparateFromArtifact: parseWorkspaceArtifactVersionTarget(
          inputs.separateFromArtifact,
        ),
      },
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    signal?.removeEventListener("abort", externalAbort);
  }
}

async function markRunFailed(
  db: Database,
  run: Run,
  message: string,
  workerId: string,
): Promise<void> {
  if (await isRunCanceled(db, run.id)) return;

  const completedAt = new Date();
  // #443: fenced on workerId — a worker that lost its lease must not write
  // a terminal state over the current owner's execution.
  const updatedRows = await db
    .update(runs)
    .set({
      status: "failed",
      error: message,
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: completedAt,
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(runs.id, run.id),
        ne(runs.status, "canceled"),
        eq(runs.workerId, workerId),
      ),
    )
    .returning({ id: runs.id });

  if (updatedRows.length === 0) return;

  await createProactiveRunNotification(db, { ...run, error: message }, "failed");

  await appendRunEventBestEffort("chat-run-event-error", {
    db,
    runId: run.id,
    eventType: "run_failed",
    status: "failed",
    label: "Background worker failed the run",
    error: message,
  });
}

/**
 * Renew this worker's lease. Returns false when the run is no longer ours —
 * canceled, finished, or claimed by another worker (#443 fencing) — so the
 * caller can abort instead of double-executing.
 */
export async function heartbeatRunLease(
  db: Database,
  runId: string,
  workerId: string,
): Promise<boolean> {
  const now = new Date();
  const leaseMs = numberFromEnv("CHAT_RUN_WORKER_LEASE_MS") ?? DEFAULT_LEASE_MS;
  const rows = await db
    .update(runs)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(runs.id, runId),
        ne(runs.status, "canceled"),
        eq(runs.workerId, workerId),
      ),
    )
    .returning({ id: runs.id });
  return rows.length > 0;
}

function parseChatRunInputs(value: unknown): ChatRunInputs {
  if (!isRecord(value)) throw new Error("Chat run inputs are missing.");
  const prompt = typeof value.prompt === "string" ? value.prompt : "";
  const threadId = typeof value.threadId === "string" ? value.threadId : "";
  const userMessageId =
    typeof value.userMessageId === "string" ? value.userMessageId : "";
  const executionMode = parseChatExecutionMode(value.executionMode);
  if (!prompt || !threadId || !userMessageId) {
    throw new Error("Chat run inputs are incomplete.");
  }
  return { ...value, prompt, threadId, userMessageId, executionMode };
}

function activatedSkillIdsFromInputs(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.activatedSkills)) return [];
  return value.activatedSkills.flatMap((skill) =>
    isRecord(skill) && typeof skill.id === "string" ? [skill.id] : [],
  );
}

function parseStoredRuntimeRoute(value: unknown): ChatRuntimeRoute | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.lane !== "fast-local" &&
    value.lane !== "tool-local" &&
    value.lane !== "durable-local"
  ) {
    return undefined;
  }
  if (
    value.runtimeTarget !== "direct-chat" &&
    value.runtimeTarget !== "bedrock-agent" &&
    value.runtimeTarget !== "agentcore-worker"
  ) {
    return undefined;
  }
  return {
    lane: value.lane,
    routingMode: parseStoredRoutingMode(value.routingMode),
    executionMode: parseChatExecutionMode(value.executionMode),
    runtimeTarget: value.runtimeTarget,
    useWorker: value.useWorker === true,
    useMcp: value.useMcp === true,
    includeVaultContext: value.includeVaultContext === true,
    reasons: Array.isArray(value.reasons)
      ? value.reasons.filter(
          (reason): reason is string => typeof reason === "string",
        )
      : ["stored_runtime_route"],
  };
}

/**
 * Legacy persisted runs may predate the deleted regex routing engine; keep
 * whatever mode they recorded so receipts stay honest about how they ran.
 */
function parseStoredRoutingMode(value: unknown): ChatRoutingMode {
  return value === "model-decided" ? "model-decided" : "regex";
}

function defaultWorkerRuntimeRoute(inputs: ChatRunInputs): ChatRuntimeRoute {
  return {
    lane: "durable-local",
    routingMode: parseStoredRoutingMode(inputs.routingMode),
    executionMode: inputs.executionMode,
    runtimeTarget: "agentcore-worker",
    useWorker: true,
    useMcp: true,
    includeVaultContext: true,
    reasons: ["legacy_worker_run"],
  };
}

function sanitizeActiveSkillPrompt(value: unknown): PinnedActiveSkill | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    typeof v.slug !== "string" ||
    typeof v.name !== "string" ||
    typeof v.systemPrompt !== "string"
  ) {
    return null;
  }
  return { id: v.id, slug: v.slug, name: v.name, systemPrompt: v.systemPrompt };
}

function sanitizeUploadedFiles(value: unknown): ChatContextUploadedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) => {
    if (!isRecord(file) || typeof file.name !== "string") return [];
    const name = file.name.trim();
    if (!name) return [];
    return [
      {
        name,
        ...(typeof file.sizeBytes === "number" && Number.isFinite(file.sizeBytes)
          ? { sizeBytes: file.sizeBytes }
          : {}),
        ...(typeof file.contentChars === "number" &&
          Number.isFinite(file.contentChars)
          ? { contentChars: file.contentChars }
          : {}),
        ...(typeof file.mimeType === "string" ? { mimeType: file.mimeType } : {}),
        ...(typeof file.extractionStatus === "string"
          ? { extractionStatus: file.extractionStatus }
          : {}),
        ...(isRuntimeImageContent(file.runtimeContent)
          ? { runtimeContent: file.runtimeContent }
          : {}),
      },
    ];
  });
}

function isRuntimeImageContent(
  value: unknown,
): value is NonNullable<ChatContextUploadedFile["runtimeContent"]> {
  if (!isRecord(value)) return false;
  return (
    value.type === "image" &&
    typeof value.dataBase64 === "string" &&
    (value.mimeType === "image/png" ||
      value.mimeType === "image/jpeg" ||
      value.mimeType === "image/webp")
  );
}

function workerRuntimeName(): "agentcore" | "bedrock" {
  if (process.env.AGENTCORE_RUNTIME_ARN) return "agentcore";
  return "bedrock";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    function onAbort() {
      clearTimeout(timeout);
      resolve();
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
