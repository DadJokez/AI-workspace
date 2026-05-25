import {
  type ChatThread,
  auditLog,
  chatMessages,
  chatThreads,
  type Database,
  recipeRuns,
  users,
} from "@ai-workspace/db";
import { eq, ne, and, asc, sql } from "drizzle-orm";
import {
  getRuntime,
  type RuntimeRunMetadata,
} from "@ai-workspace/cursor-runtime";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import {
  enqueueMemoryCapture,
  startInProcessMemoryCaptureScheduler,
} from "@/lib/memory-capture";
import { buildUserMcpServers } from "@/lib/oauth/mcp-servers";
import {
  appendRunEventWithNextSequence,
  appendToolCallRunEvent,
  appendToolResultRunEvent,
} from "@/lib/run-events";
import { createToolEventAccumulator } from "@/lib/tool-events";
import { buildTurnContext } from "@/lib/turn-context";
import { loadApprovedVaultMarkdown } from "@/lib/vault-memory";

type InlineTerminalStatus = "succeeded" | "failed";

export type ChatStreamSend = (event: Record<string, unknown>) => void;

export interface StreamInlineChatRunInput {
  db: Database;
  runId: string;
  thread: ChatThread;
  userId: string;
  userMessageId: string;
  prompt: string;
  modelId: string;
  route: ChatRuntimeRoute;
  signal?: AbortSignal;
  send: ChatStreamSend;
}

export async function streamInlineChatRun({
  db,
  runId,
  thread,
  userId,
  userMessageId,
  prompt,
  modelId,
  route,
  signal,
  send,
}: StreamInlineChatRunInput): Promise<void> {
  const runtime = getRuntime({ db, executionMode: "local" });
  const runtimeAbort = new AbortController();
  const externalAbort = () => runtimeAbort.abort();
  signal?.addEventListener("abort", externalAbort, { once: true });

  let assistantText = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let providerRunMetadata: RuntimeRunMetadata | null = null;
  const runtimeErrors: string[] = [];
  const toolEvents = createToolEventAccumulator([]);

  try {
    const [userRows, history, vaultMarkdown] = await Promise.all([
      db
        .select({
          displayName: users.displayName,
          customInstructions: users.customInstructions,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.threadId, thread.id))
        .orderBy(asc(chatMessages.createdAt)),
      route.includeVaultContext
        ? loadApprovedVaultMarkdown(db, userId)
        : Promise.resolve(null),
    ]);

    const user = userRows[0] ?? {
      displayName: "User",
      customInstructions: null,
    };
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
            userId,
            runId,
            ...event,
          })}\n`,
        );
      },
    });

    let mcpServers;
    let deniedMcpProviders: string[] = [];
    if (route.useMcp) {
      try {
        const mcpAccess = await buildUserMcpServers(db, userId);
        mcpServers = mcpAccess.mcpServers;
        deniedMcpProviders = mcpAccess.deniedProviders;
      } catch (err) {
        process.stderr.write(
          `[mcp-build-error] ${JSON.stringify({
            runId,
            threadId: thread.id,
            message: err instanceof Error ? err.message : String(err),
          })}\n`,
        );
      }
    }

    const connectedProviders = mcpServers ? Object.keys(mcpServers) : [];
    const firstTurnPreamble =
      route.useMcp ||
      route.includeVaultContext ||
      Boolean(user.customInstructions?.trim())
        ? buildAgentPreamble({
            user: {
              displayName: user.displayName,
              customInstructions: user.customInstructions,
              vaultMarkdown,
            },
            connectedProviders,
            blockedProviders: deniedMcpProviders,
          })
        : undefined;

    await db
      .update(recipeRuns)
      .set({
        runtime: runtime.name,
        inputs: {
          prompt,
          threadId: thread.id,
          userMessageId,
          requestedByUserId: userId,
          executionMode: route.executionMode,
          runtimeRoute: route,
          mcpProviders: connectedProviders,
          deniedMcpProviders,
        },
        updatedAt: new Date(),
      })
      .where(eq(recipeRuns.id, runId));

    await appendInlineRunEvent(db, runId, {
      eventType: "inline_runtime_started",
      status: "pending",
      label:
        route.lane === "tool-local"
          ? "Started local streaming run with tools"
          : "Started local streaming run",
      metadata: {
        lane: route.lane,
        reasons: route.reasons,
        mcpProviders: connectedProviders,
      },
    });

    for await (const ev of runtime.runTurn({
      threadId: thread.id,
      modelId,
      messages: agentMessages,
      context: { userId },
      signal: runtimeAbort.signal,
      firstTurnPreamble,
      onRunStarted: async (metadata) => {
        providerRunMetadata = metadata;
        await db
          .update(recipeRuns)
          .set({
            outputs: {
              assistantText,
              lifecycle: "provider_started",
              providerRun: metadata,
            },
            updatedAt: new Date(),
          })
          .where(eq(recipeRuns.id, runId));
        await appendInlineRunEvent(db, runId, {
          eventType: "provider_run_started",
          status: "pending",
          label: "Started Cursor run",
          metadata: metadata as unknown as Record<string, unknown>,
        });
      },
      ...(mcpServers ? { mcpServers } : {}),
    })) {
      if (signal?.aborted) {
        runtimeAbort.abort();
        break;
      }
      if (ev.type === "text-delta") {
        assistantText += ev.delta;
        send({ type: "text-delta", delta: ev.delta });
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
            recipeRunId: runId,
            sequence: await nextRunEventSequence(db, runId),
            call: persistedCall,
          });
        }
        send({ type: "tool-call", call: ev.call });
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
            recipeRunId: runId,
            sequence: await nextRunEventSequence(db, runId),
            call: persistedCall,
            result: persistedResult,
          });
        }
        send({ type: "tool-result", result: ev.result });
      } else if (ev.type === "error") {
        runtimeErrors.push(ev.message);
        send({ type: "error", message: ev.message });
      }
    }

    const runError = signal?.aborted
      ? "Browser request disconnected before the local chat run completed."
      : runtimeErrors.length > 0
        ? runtimeErrors.join("\n")
        : null;

    const assistantMessageId = await persistInlineAssistantResult({
      db,
      runId,
      userId,
      threadId: thread.id,
      userMessageId,
      modelId,
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

    if (runError) return;

    send({ type: "done" });
    send({
      type: "persisted",
      assistantMessageId,
      runId,
      threadId: thread.id,
    });
  } finally {
    signal?.removeEventListener("abort", externalAbort);
  }
}

async function persistInlineAssistantResult({
  db,
  runId,
  userId,
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
  runId: string;
  userId: string;
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
  terminalStatus: InlineTerminalStatus;
  error: string | null;
}): Promise<string | undefined> {
  let assistantMessageId: string | undefined;
  const shouldPersistAssistant =
    terminalStatus === "succeeded" ||
    assistantText.trim().length > 0 ||
    toolCalls.length > 0 ||
    toolResults.length > 0;

  if (shouldPersistAssistant) {
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

  if (assistantMessageId) {
    const toolAuditRows = buildToolAuditRows({
      actorUserId: userId,
      chatThreadId: threadId,
      chatMessageId: assistantMessageId,
      recipeRunId: runId,
      modelId,
      runtime: runtimeName,
      calls: toolCalls,
      results: toolResults,
    });
    if (toolAuditRows.length > 0) {
      await db.insert(auditLog).values(toolAuditRows);
    }
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
        assistantText,
        ...(assistantMessageId ? { assistantMessageId } : {}),
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
    .where(and(eq(recipeRuns.id, runId), ne(recipeRuns.status, "canceled")));

  if (terminalStatus === "succeeded" && assistantMessageId) {
    try {
      await enqueueMemoryCapture(db, {
        userId,
        threadId,
        fromMessageId: userMessageId,
        toMessageId: assistantMessageId,
        recipeRunId: runId,
        reason: "chat_turn",
      });
      startInProcessMemoryCaptureScheduler({ db });
    } catch (err) {
      process.stderr.write(
        `[memory-capture-enqueue-error] ${JSON.stringify({
          runId,
          threadId,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  }

  await appendInlineRunEvent(db, runId, {
    eventType: terminalStatus === "succeeded" ? "run_completed" : "run_failed",
    status: terminalStatus,
    label:
      terminalStatus === "succeeded"
        ? "Stored assistant answer"
        : "Run ended with errors",
    ...(error ? { error } : {}),
    metadata: { assistantMessageId, userMessageId },
  });

  return assistantMessageId;
}

async function appendInlineRunEvent(
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
      `[chat-inline-event-error] ${JSON.stringify({
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

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
