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
  runs,
  type Run,
  users,
} from "@ai-workspace/db";
import { and, asc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import {
  enqueueMemoryCapture,
  startInProcessMemoryCaptureScheduler,
} from "@/lib/memory-capture";
import { buildUserMcpServers } from "@/lib/oauth/mcp-servers";
import {
  buildArtifactContext,
  buildArtifactLookupMessage,
} from "@/lib/artifact-context";
import {
  appendRunEventWithNextSequence,
  appendToolCallRunEvent,
  appendToolResultRunEvent,
} from "@/lib/run-events";
import {
  parseChatExecutionMode,
  type ChatExecutionMode,
} from "@/lib/chat-execution-mode";
import { createToolEventAccumulator } from "@/lib/tool-events";
import { refreshThreadPresentationMetadata } from "@/lib/thread-metadata";
import { buildTurnContext } from "@/lib/turn-context";
import { loadApprovedVaultMarkdown } from "@/lib/vault-memory";
import { createArtifactsFromAssistantMessage } from "@/lib/workspace-artifacts";

const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_RUNTIME_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

type ChatRunWorkerStatus = "idle" | "running" | "succeeded" | "failed";
type ChatRunTerminalStatus = "succeeded" | "failed";

interface ChatRunInputs {
  prompt: string;
  threadId: string;
  userMessageId: string;
  executionMode: ChatExecutionMode;
  /** Skill runs restrict MCP mounting to their declared providers. */
  requestedProviders?: string[];
  [key: string]: unknown;
}

/**
 * Runs this worker may claim: chat turns (identified by the historical
 * `skill_slug = "chat-turn"` marker) plus skill/scheduled runs (identified
 * by trigger type so any skill slug works). Inputs for all of them satisfy
 * the same {prompt, threadId, userMessageId} contract.
 */
const WORKER_TRIGGER_TYPES = ["skill", "scheduled", "skill_retry"];

function claimableRunCondition() {
  return or(
    eq(runs.skillSlug, "chat-turn"),
    inArray(runs.triggerType, WORKER_TRIGGER_TYPES),
  );
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
    if (await isRunCanceled(db, claimed.id)) {
      return { status: "succeeded", runId: claimed.id };
    }
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

  const runtime = getRuntime({ db, executionMode: inputs.executionMode });
  const [threadRows, userRows, vaultMarkdown] = await Promise.all([
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
    loadApprovedVaultMarkdown(db, run.userId),
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

  // Match artifacts against recent RAW user messages, not the attachment-folded
  // prompt (see chat-inline-runner for the rationale).
  const artifactContext = await buildArtifactContext({
    db,
    userId: run.userId,
    message: buildArtifactLookupMessage(history, inputs.prompt),
  });

  const agentMessages = buildTurnContext({
    messages: history,
    currentMessageContent: inputs.prompt,
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
    const mcpAccess = await buildUserMcpServers(
      db,
      run.userId,
      Array.isArray(inputs.requestedProviders)
        ? { onlyProviders: inputs.requestedProviders }
        : undefined,
    );
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
        runId: run.id,
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
      vaultMarkdown,
    },
    connectedProviders: mcpServers ? Object.keys(mcpServers) : [],
    blockedProviders: deniedMcpProviders,
    modelId: run.modelId ?? undefined,
    artifactContext,
  });

  await db
    .update(runs)
    .set({
      runtime: runtime.name,
      inputs: {
        ...inputs,
        mcpProviders: mcpServers ? Object.keys(mcpServers) : [],
        deniedMcpProviders,
      },
      updatedAt: new Date(),
    })
    .where(eq(runs.id, run.id));

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
      metadata: {
        runtime: runtime.name,
        modelId: run.modelId,
        executionMode: inputs.executionMode,
      },
    });

    try {
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
            .update(runs)
            .set({
              outputs: buildOutput({
                lifecycle: "provider_started",
                providerRun: metadata,
              }),
              updatedAt: new Date(),
            })
            .where(eq(runs.id, run.id));
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
        if (await isRunCanceled(db, run.id)) {
          runtimeAbort.abort();
          break;
        }
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
              runId: run.id,
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
              runId: run.id,
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
    } catch (err) {
      if (await isRunCanceled(db, run.id)) {
        runtimeAbort.abort();
      } else {
        throw err;
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    signal?.removeEventListener("abort", externalAbort);
  }

  if (await isRunCanceled(db, run.id)) {
    await appendWorkerRunEvent(db, run.id, {
      eventType: "worker_stopped_after_cancel",
      status: "failed",
      label: "Worker stopped after cancellation",
    });
    return;
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
  run: Run;
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
    if (await isRunCanceled(db, run.id)) {
      return;
    }
    await heartbeatRunLease(db, run.id);
    const snapshot = await getCursorCloudRunSnapshot({
      apiKey: process.env.CURSOR_API_KEY,
      providerAgentId: providerRun.providerAgentId,
      providerRunId: providerRun.providerRunId,
    });

    await db
      .update(runs)
      .set({
        outputs: {
          ...parseOutput(run.outputs),
          providerRun,
          providerRunSnapshot: snapshot,
          providerRunLastCheckedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(runs.id, run.id));

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
  run: Run;
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
  if (await isRunCanceled(db, run.id)) return;

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
    runId: run.id,
    modelId,
    runtime: runtimeName,
    calls: toolCalls,
    results: toolResults,
  });
  if (toolAuditRows.length > 0) {
    await db.insert(auditLog).values(toolAuditRows);
  }

  const artifacts =
    terminalStatus === "succeeded"
      ? await createArtifactsFromAssistantMessage({
          db,
          userId: run.userId,
          threadId,
          chatMessageId: assistantMessageId,
          runId: run.id,
          assistantText,
        }).catch((err) => {
          process.stderr.write(
            `[workspace-artifact-create-error] ${JSON.stringify({
              runId: run.id,
              threadId,
              assistantMessageId,
              message: err instanceof Error ? err.message : String(err),
            })}\n`,
          );
          return [];
        })
      : [];

  if (await isRunCanceled(db, run.id)) return;

  const completedAt = new Date();
  await refreshThreadPresentationMetadata({
    db,
    threadId,
    now: completedAt,
  });

  const updatedRows = await db
    .update(runs)
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
        ...(artifacts.length > 0 ? { artifacts } : {}),
      },
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: completedAt,
      completedAt,
      updatedAt: completedAt,
    })
    .where(and(eq(runs.id, run.id), ne(runs.status, "canceled")))
    .returning({ id: runs.id });

  if (updatedRows.length === 0) return;

  if (terminalStatus === "succeeded") {
    try {
      await enqueueMemoryCapture(db, {
        userId: run.userId,
        threadId,
        fromMessageId: userMessageId,
        toMessageId: assistantMessageId,
        runId: run.id,
        reason: "chat_turn",
      });
      startInProcessMemoryCaptureScheduler({ db });
    } catch (err) {
      process.stderr.write(
        `[memory-capture-enqueue-error] ${JSON.stringify({
          runId: run.id,
          threadId,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  }

  await appendWorkerRunEvent(db, run.id, {
    eventType: terminalStatus === "succeeded" ? "run_completed" : "run_failed",
    status: terminalStatus,
    label:
      terminalStatus === "succeeded"
        ? "Stored assistant answer"
        : "Run ended with errors",
    ...(error ? { error } : {}),
    metadata: {
      assistantMessageId,
      userMessageId,
      ...(artifacts.length > 0 ? { artifacts } : {}),
    },
  });
}

async function markRunFailed(
  db: Database,
  run: Run,
  message: string,
): Promise<void> {
  if (await isRunCanceled(db, run.id)) return;

  const completedAt = new Date();
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
    .where(and(eq(runs.id, run.id), ne(runs.status, "canceled")))
    .returning({ id: runs.id });

  if (updatedRows.length === 0) return;

  await appendWorkerRunEvent(db, run.id, {
    eventType: "run_failed",
    status: "failed",
    label: "Background worker failed the run",
    error: message,
  });
}

async function markRunCanceled(
  db: Database,
  run: Run,
  message: string,
): Promise<void> {
  const completedAt = new Date();
  await db
    .update(runs)
    .set({
      status: "canceled",
      error: message,
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: completedAt,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(runs.id, run.id));

  await appendWorkerRunEvent(db, run.id, {
    eventType: "run_canceled",
    status: "failed",
    label: "Cursor Cloud run was canceled",
    error: message,
  });
}

async function heartbeatRunLease(db: Database, runId: string): Promise<void> {
  const now = new Date();
  const leaseMs = numberFromEnv("CHAT_RUN_WORKER_LEASE_MS") ?? DEFAULT_LEASE_MS;
  await db
    .update(runs)
    .set({
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(and(eq(runs.id, runId), ne(runs.status, "canceled")));
}

async function isRunCanceled(db: Database, runId: string): Promise<boolean> {
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0]?.status === "canceled";
}

async function appendWorkerRunEvent(
  db: Database,
  runId: string,
  input: Omit<
    Parameters<typeof appendRunEventWithNextSequence>[0],
    "db" | "runId"
  >,
): Promise<void> {
  try {
    await appendRunEventWithNextSequence({ db, runId, ...input });
  } catch (err) {
    process.stderr.write(
      `[chat-run-event-error] ${JSON.stringify({
        runId: runId,
        eventType: input.eventType,
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}

async function nextRunEventSequence(
  db: Database,
  runId: string,
): Promise<number> {
  const rows = await db.execute<{ sequence: number }>(
    sql`select coalesce(max(sequence), 0)::int + 1 as sequence from run_events where run_id = ${runId}`,
  );
  return rows[0]?.sequence ?? 1;
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
