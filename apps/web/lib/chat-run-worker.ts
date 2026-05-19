import {
  getCursorCloudRunSnapshot,
  getRuntime,
  type RuntimeRunMetadata,
} from "@ai-workspace/cursor-runtime";
import {
  auditLog,
  chatMessages,
  chatThreads,
  type Database,
  recipeRuns,
  type RecipeRun,
  users,
} from "@ai-workspace/db";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import { buildUserMcpServers } from "@/lib/oauth/mcp-servers";
import {
  appendRunEventWithNextSequence,
  appendToolCallRunEvent,
  appendToolResultRunEvent,
} from "@/lib/run-events";
import { createToolEventAccumulator } from "@/lib/tool-events";
import { buildTurnContext } from "@/lib/turn-context";

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RUNTIME_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

type ChatRunWorkerStatus = "idle" | "running" | "succeeded" | "failed";
type ChatRunTerminalStatus = "succeeded" | "failed";

interface ChatRunInputs {
  prompt: string;
  threadId: string;
  userMessageId: string;
  [key: string]: unknown;
}

interface StoredChatRunOutput {
  assistantText?: string;
  assistantMessageId?: string;
  providerRun?: RuntimeRunMetadata;
  [key: string]: unknown;
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
  while (!signal?.aborted) {
    const result = await processQueuedChatRun({ db, workerId, signal });
    if (result.status === "idle") {
      await delay(pollIntervalMs, signal);
    }
  }
}

export async function processQueuedChatRun({
  db,
  runId,
  workerId = `worker-${process.pid}`,
  signal,
}: ProcessChatRunInput): Promise<{ status: ChatRunWorkerStatus; runId?: string }> {
  const claimed = await claimChatRun({ db, runId, workerId });
  if (!claimed) return { status: "idle" };

  try {
    await executeClaimedChatRun({ db, run: claimed, workerId, signal });
    return { status: "succeeded", runId: claimed.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(db, claimed, message);
    process.stderr.write(
      `[chat-run-worker-error] ${JSON.stringify({
        runId: claimed.id,
        threadId: claimed.threadId,
        message,
      })}\n`,
    );
    return { status: "failed", runId: claimed.id };
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
}): Promise<RecipeRun | null> {
  const id = runId ?? (await findNextClaimableRunId(db));
  if (!id) return null;

  const now = new Date();
  const leaseMs = numberFromEnv("CHAT_RUN_WORKER_LEASE_MS") ?? DEFAULT_LEASE_MS;
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  const rows = await db
    .update(recipeRuns)
    .set({
      status: "running",
      workerId,
      leaseExpiresAt,
      lastHeartbeatAt: now,
      attemptCount: sql`${recipeRuns.attemptCount} + 1`,
      startedAt: sql`coalesce(${recipeRuns.startedAt}, now())`,
      updatedAt: now,
    })
    .where(
      and(
        eq(recipeRuns.id, id),
        eq(recipeRuns.recipeSlug, "chat-turn"),
        or(
          eq(recipeRuns.status, "queued"),
          and(eq(recipeRuns.status, "running"), lt(recipeRuns.leaseExpiresAt, now)),
        ),
      ),
    )
    .returning();

  return rows[0] ?? null;
}

async function findNextClaimableRunId(db: Database): Promise<string | null> {
  const now = new Date();
  const rows = await db
    .select({ id: recipeRuns.id })
    .from(recipeRuns)
    .where(
      and(
        eq(recipeRuns.recipeSlug, "chat-turn"),
        or(
          eq(recipeRuns.status, "queued"),
          and(eq(recipeRuns.status, "running"), lt(recipeRuns.leaseExpiresAt, now)),
        ),
      ),
    )
    .orderBy(asc(recipeRuns.createdAt))
    .limit(1);

  return rows[0]?.id ?? null;
}

async function executeClaimedChatRun({
  db,
  run,
  workerId,
  signal,
}: {
  db: Database;
  run: RecipeRun;
  workerId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const inputs = parseChatRunInputs(run.inputs);
  const threadId = inputs.threadId;
  const existingOutput = parseOutput(run.outputs);

  await appendWorkerRunEvent(db, run.id, {
    eventType: "worker_claimed",
    status: "pending",
    label: "Background worker claimed the run",
    metadata: { workerId },
  });

  const existingProviderRun = existingOutput.providerRun;
  if (
    existingProviderRun?.executionMode === "cloud" &&
    existingProviderRun.providerAgentId &&
    existingProviderRun.providerRunId &&
    !existingOutput.assistantMessageId
  ) {
    await reconcileExistingCursorCloudRun({
      db,
      run,
      threadId,
      userMessageId: inputs.userMessageId,
      providerRun: {
        ...existingProviderRun,
        providerAgentId: existingProviderRun.providerAgentId,
        providerRunId: existingProviderRun.providerRunId,
      },
      signal,
    });
    return;
  }

  const runtime = getRuntime({ db });
  const [threadRows, userRows] = await Promise.all([
    db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1),
    db
      .select({
        displayName: users.displayName,
        customInstructions: users.customInstructions,
      })
      .from(users)
      .where(eq(users.id, run.userId))
      .limit(1),
  ]);

  const thread = threadRows[0];
  if (!thread) throw new Error("Chat thread was not found for queued run.");
  const user = userRows[0] ?? {
    displayName: "User",
    customInstructions: null,
  };

  const history = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, thread.id))
    .orderBy(asc(chatMessages.createdAt));

  const agentMessages = buildTurnContext({
    messages: history,
    threadSummary: thread.summary,
    recentMessageLimit: numberFromEnv("CHAT_RECENT_MESSAGE_LIMIT"),
    maxContextChars: numberFromEnv("CHAT_CONTEXT_CHAR_LIMIT"),
    maxMessageChars: numberFromEnv("CHAT_CONTEXT_MESSAGE_CHAR_LIMIT"),
    onGuardrailEvent: (event) => {
      process.stderr.write(
        `[turn-context-guardrail] ${JSON.stringify({
          threadId: thread.id,
          userId: run.userId,
          runId: run.id,
          ...event,
        })}\n`,
      );
    },
  });

  let mcpServers;
  let deniedMcpProviders: string[] = [];
  try {
    const mcpAccess = await buildUserMcpServers(db, run.userId);
    mcpServers = mcpAccess.mcpServers;
    deniedMcpProviders = mcpAccess.deniedProviders;
  } catch (err) {
    process.stderr.write(
      `[mcp-build-error] ${JSON.stringify({
        runId: run.id,
        threadId: thread.id,
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }

  if (deniedMcpProviders.length > 0) {
    await db.insert(auditLog).values(
      deniedMcpProviders.map((provider) => ({
        actorUserId: run.userId,
        actionType: "mcp_tool_attestation",
        status: "denied" as const,
        provider,
        toolName: "*",
        chatThreadId: thread.id,
        recipeRunId: run.id,
        input: { provider },
        error: `Tool provider "${provider}" is connected but has no active user attestation.`,
        metadata: { modelId: run.modelId, runtime: runtime.name },
        startedAt: new Date(),
        completedAt: new Date(),
      })),
    );
  }

  const firstTurnPreamble = buildAgentPreamble({
    user: {
      displayName: user.displayName,
      customInstructions: user.customInstructions,
    },
    connectedProviders: mcpServers ? Object.keys(mcpServers) : [],
    blockedProviders: deniedMcpProviders,
  });

  await db
    .update(recipeRuns)
    .set({
      runtime: runtime.name,
      inputs: {
        ...inputs,
        mcpProviders: mcpServers ? Object.keys(mcpServers) : [],
        deniedMcpProviders,
      },
      updatedAt: new Date(),
    })
    .where(eq(recipeRuns.id, run.id));

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

  const heartbeat = setInterval(() => {
    void heartbeatRunLease(db, run.id).catch((err) => {
      process.stderr.write(
        `[chat-run-heartbeat-error] ${JSON.stringify({
          runId: run.id,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    });
  }, Math.max(15_000, Math.floor((numberFromEnv("CHAT_RUN_WORKER_LEASE_MS") ?? DEFAULT_LEASE_MS) / 3)));
  heartbeat.unref?.();

  let assistantText = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let providerRunMetadata: RuntimeRunMetadata | null =
    parseOutput(run.outputs).providerRun ?? null;
  const runtimeErrors: string[] = [];
  const toolEvents = createToolEventAccumulator(
    mcpServers ? Object.keys(mcpServers) : [],
  );
  const buildOutput = (extra: Record<string, unknown> = {}) => ({
    ...parseOutput(run.outputs),
    assistantText,
    toolCalls: toolEvents.calls(),
    toolResults: toolEvents.results(),
    tokensIn,
    tokensOut,
    modelId: run.modelId,
    runtime: runtime.name,
    ...(providerRunMetadata ? { providerRun: providerRunMetadata } : {}),
    ...extra,
  });

  try {
    await appendWorkerRunEvent(db, run.id, {
      eventType: "worker_started",
      status: "pending",
      label: "Background worker started the agent run",
      metadata: { runtime: runtime.name, modelId: run.modelId },
    });

    for await (const ev of runtime.runTurn({
      threadId: thread.id,
      modelId: run.modelId ?? "default",
      messages: agentMessages,
      context: { userId: run.userId },
      signal: runtimeAbort.signal,
      firstTurnPreamble,
      onRunStarted: async (metadata) => {
        providerRunMetadata = metadata;
        await db
          .update(recipeRuns)
          .set({
            outputs: buildOutput({
              lifecycle: "provider_started",
              providerRun: metadata,
            }),
            updatedAt: new Date(),
          })
          .where(eq(recipeRuns.id, run.id));
        await appendWorkerRunEvent(db, run.id, {
          eventType: "provider_run_started",
          status: "pending",
          label:
            metadata.executionMode === "cloud"
              ? "Started Cursor Cloud run"
              : "Started Cursor run",
          metadata: metadata as unknown as Record<string, unknown>,
        });
      },
      ...(mcpServers ? { mcpServers } : {}),
    })) {
      if (ev.type === "text-delta") {
        assistantText += ev.delta;
      } else if (ev.type === "usage") {
        tokensIn = ev.tokensIn;
        tokensOut = ev.tokensOut;
      } else if (ev.type === "tool-call") {
        toolEvents.recordCall(ev.call);
        const persistedCall = toolEvents
          .calls()
          .find((call) => call.id === ev.call.id);
        if (persistedCall) {
          await appendToolCallRunEvent({
            db,
            recipeRunId: run.id,
            sequence: await nextRunEventSequence(db, run.id),
            call: persistedCall,
          });
        }
      } else if (ev.type === "tool-result") {
        toolEvents.recordResult(ev.result);
        const persistedResult = toolEvents
          .results()
          .find((result) => result.toolCallId === ev.result.toolCallId);
        if (persistedResult) {
          const persistedCall = toolEvents
            .calls()
            .find((call) => call.id === ev.result.toolCallId);
          await appendToolResultRunEvent({
            db,
            recipeRunId: run.id,
            sequence: await nextRunEventSequence(db, run.id),
            call: persistedCall,
            result: persistedResult,
          });
        }
      } else if (ev.type === "error") {
        runtimeErrors.push(ev.message);
        process.stderr.write(
          `[chat-run-worker-runtime-error] ${JSON.stringify({
            runId: run.id,
            threadId: thread.id,
            message: ev.message,
          })}\n`,
        );
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    signal?.removeEventListener("abort", externalAbort);
  }

  if (
    !runtimeAbort.signal.aborted &&
    runtimeErrors.length > 0 &&
    providerRunMetadata?.executionMode === "cloud" &&
    providerRunMetadata.providerAgentId &&
    providerRunMetadata.providerRunId
  ) {
    await reconcileExistingCursorCloudRun({
      db,
      run,
      threadId: thread.id,
      userMessageId: inputs.userMessageId,
      providerRun: {
        ...providerRunMetadata,
        providerAgentId: providerRunMetadata.providerAgentId,
        providerRunId: providerRunMetadata.providerRunId,
      },
      signal,
    });
    return;
  }

  const timeoutError = runtimeAbort.signal.aborted
    ? `Chat runtime timed out after ${timeoutMs}ms.`
    : null;
  const runError =
    timeoutError ?? (runtimeErrors.length > 0 ? runtimeErrors.join("\n") : null);

  await persistAssistantResult({
    db,
    run,
    threadId: thread.id,
    userMessageId: inputs.userMessageId,
    modelId: run.modelId ?? "default",
    runtimeName: runtime.name,
    assistantText,
    tokensIn,
    tokensOut,
    toolCalls: toolEvents.calls(),
    toolResults: toolEvents.results(),
    providerRunMetadata,
    terminalStatus: runError ? "failed" : "succeeded",
    error: runError,
  });
}

async function reconcileExistingCursorCloudRun({
  db,
  run,
  threadId,
  userMessageId,
  providerRun,
  signal,
}: {
  db: Database;
  run: RecipeRun;
  threadId: string;
  userMessageId: string;
  providerRun: RuntimeRunMetadata & {
    providerAgentId: string;
    providerRunId: string;
  };
  signal?: AbortSignal;
}): Promise<void> {
  await appendWorkerRunEvent(db, run.id, {
    eventType: "provider_run_reconcile_started",
    status: "pending",
    label: "Reconnected to existing Cursor Cloud run",
    metadata: {
      providerAgentId: providerRun.providerAgentId,
      providerRunId: providerRun.providerRunId,
    },
  });

  const pollIntervalMs =
    numberFromEnv("CHAT_RUN_PROVIDER_POLL_INTERVAL_MS") ?? 15_000;
  const timeoutMs =
    numberFromEnv("CHAT_WORKER_RUNTIME_TIMEOUT_MS") ??
    DEFAULT_RUNTIME_TIMEOUT_MS;
  const expiresAt = Date.now() + timeoutMs;

  while (!signal?.aborted) {
    await heartbeatRunLease(db, run.id);
    const snapshot = await getCursorCloudRunSnapshot({
      apiKey: process.env.CURSOR_API_KEY,
      providerAgentId: providerRun.providerAgentId,
      providerRunId: providerRun.providerRunId,
    });

    await db
      .update(recipeRuns)
      .set({
        outputs: {
          ...parseOutput(run.outputs),
          providerRun,
          providerRunSnapshot: snapshot,
          providerRunLastCheckedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(recipeRuns.id, run.id));

    if (snapshot.status !== "running") {
      if (snapshot.status === "finished") {
        await persistAssistantResult({
          db,
          run,
          threadId,
          userMessageId,
          modelId: snapshot.modelId ?? run.modelId ?? "default",
          runtimeName: run.runtime ?? providerRun.runtime ?? "cursor",
          assistantText: snapshot.result ?? "",
          tokensIn: 0,
          tokensOut: 0,
          toolCalls: [],
          toolResults: [],
          providerRunMetadata: providerRun,
          terminalStatus: "succeeded",
          error: null,
        });
      } else if (snapshot.status === "cancelled") {
        await markRunCanceled(db, run, "Cursor Cloud run was canceled.");
      } else {
        await markRunFailed(db, run, "Cursor Cloud run ended with an error.");
      }
      return;
    }

    if (Date.now() >= expiresAt) {
      throw new Error(`Cursor Cloud run did not finish within ${timeoutMs}ms.`);
    }

    await delay(pollIntervalMs, signal);
  }

  throw new Error("Chat run worker was stopped while reconciling provider run.");
}

async function persistAssistantResult({
  db,
  run,
  threadId,
  userMessageId,
  modelId,
  runtimeName,
  assistantText,
  tokensIn,
  tokensOut,
  toolCalls,
  toolResults,
  providerRunMetadata,
  terminalStatus,
  error,
}: {
  db: Database;
  run: RecipeRun;
  threadId: string;
  userMessageId: string;
  modelId: string;
  runtimeName: string;
  assistantText: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: ReturnType<ReturnType<typeof createToolEventAccumulator>["calls"]>;
  toolResults: ReturnType<ReturnType<typeof createToolEventAccumulator>["results"]>;
  providerRunMetadata: RuntimeRunMetadata | null;
  terminalStatus: ChatRunTerminalStatus;
  error: string | null;
}): Promise<void> {
  const output = parseOutput(run.outputs);
  let assistantMessageId = output.assistantMessageId;

  if (!assistantMessageId) {
    const persisted = await db
      .insert(chatMessages)
      .values({
        threadId,
        role: "assistant",
        content: assistantText,
        modelId,
        runtime: runtimeName,
        tokensIn,
        tokensOut,
        toolCalls,
        toolResults,
      })
      .returning({ id: chatMessages.id });
    assistantMessageId = persisted[0]!.id;
  }

  const toolAuditRows = buildToolAuditRows({
    actorUserId: run.userId,
    chatThreadId: threadId,
    chatMessageId: assistantMessageId,
    recipeRunId: run.id,
    modelId,
    runtime: runtimeName,
    calls: toolCalls,
    results: toolResults,
  });
  if (toolAuditRows.length > 0) {
    await db.insert(auditLog).values(toolAuditRows);
  }

  await db
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, threadId));

  const completedAt = new Date();
  await db
    .update(recipeRuns)
    .set({
      status: terminalStatus,
      error,
      outputs: {
        ...output,
        assistantText,
        assistantMessageId,
        userMessageId,
        toolCalls,
        toolResults,
        tokensIn,
        tokensOut,
        modelId,
        runtime: runtimeName,
        ...(providerRunMetadata ? { providerRun: providerRunMetadata } : {}),
      },
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: completedAt,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(recipeRuns.id, run.id));

  await appendWorkerRunEvent(db, run.id, {
    eventType: terminalStatus === "succeeded" ? "run_completed" : "run_failed",
    status: terminalStatus,
    label:
      terminalStatus === "succeeded"
        ? "Stored assistant answer"
        : "Run ended with errors",
    ...(error ? { error } : {}),
    metadata: { assistantMessageId, userMessageId },
  });
}

async function markRunFailed(
  db: Database,
  run: RecipeRun,
  message: string,
): Promise<void> {
  const completedAt = new Date();
  await db
    .update(recipeRuns)
    .set({
      status: "failed",
      error: message,
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: completedAt,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(recipeRuns.id, run.id));

  await appendWorkerRunEvent(db, run.id, {
    eventType: "run_failed",
    status: "failed",
    label: "Background worker failed the run",
    error: message,
  });
}

async function markRunCanceled(
  db: Database,
  run: RecipeRun,
  message: string,
): Promise<void> {
  const completedAt = new Date();
  await db
    .update(recipeRuns)
    .set({
      status: "canceled",
      error: message,
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: completedAt,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(recipeRuns.id, run.id));

  await appendWorkerRunEvent(db, run.id, {
    eventType: "run_failed",
    status: "failed",
    label: "Cursor Cloud run was canceled",
    error: message,
  });
}

async function heartbeatRunLease(db: Database, runId: string): Promise<void> {
  const now = new Date();
  const leaseMs = numberFromEnv("CHAT_RUN_WORKER_LEASE_MS") ?? DEFAULT_LEASE_MS;
  await db
    .update(recipeRuns)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(recipeRuns.id, runId));
}

async function appendWorkerRunEvent(
  db: Database,
  recipeRunId: string,
  input: Omit<
    Parameters<typeof appendRunEventWithNextSequence>[0],
    "db" | "recipeRunId"
  >,
): Promise<void> {
  try {
    await appendRunEventWithNextSequence({ db, recipeRunId, ...input });
  } catch (err) {
    process.stderr.write(
      `[chat-run-event-error] ${JSON.stringify({
        runId: recipeRunId,
        eventType: input.eventType,
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}

async function nextRunEventSequence(
  db: Database,
  recipeRunId: string,
): Promise<number> {
  const rows = await db.execute<{ sequence: number }>(
    sql`select coalesce(max(sequence), 0)::int + 1 as sequence from run_events where recipe_run_id = ${recipeRunId}`,
  );
  return rows[0]?.sequence ?? 1;
}

function parseChatRunInputs(value: unknown): ChatRunInputs {
  if (!isRecord(value)) throw new Error("Chat run inputs are missing.");
  const prompt = typeof value.prompt === "string" ? value.prompt : "";
  const threadId = typeof value.threadId === "string" ? value.threadId : "";
  const userMessageId =
    typeof value.userMessageId === "string" ? value.userMessageId : "";
  if (!prompt || !threadId || !userMessageId) {
    throw new Error("Chat run inputs are incomplete.");
  }
  return { ...value, prompt, threadId, userMessageId };
}

function parseOutput(value: unknown): StoredChatRunOutput {
  if (!isRecord(value)) return {};
  return value as StoredChatRunOutput;
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
