import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { AuthConfigError } from "@ai-workspace/auth";
import { getRuntime, type RuntimeRunMetadata } from "@ai-workspace/cursor-runtime";
import {
  auditLog,
  type ChatThread,
  chatMessages,
  chatThreads,
  getDb,
  recipeRuns,
  users,
} from "@ai-workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";
import { buildUserMcpServers } from "@/lib/oauth/mcp-servers";
import {
  checkRateLimit,
  contentLengthTooLarge,
  requestLimitConfig,
} from "@/lib/request-limits";
import {
  appendRunEvent,
  appendToolCallRunEvent,
  appendToolResultRunEvent,
  type AppendRunEventInput,
} from "@/lib/run-events";
import { createToolEventAccumulator } from "@/lib/tool-events";
import { buildTurnContext } from "@/lib/turn-context";

export const dynamic = "force-dynamic";

const CHAT_RUNTIME_TIMEOUT_MS = 8 * 60 * 1000;

// One-time diagnostic: surface Node's `warning` events with their stack so
// MaxListenersExceeded (and similar) point at the actual leaking call site.
// Guarded against multiple registrations under HMR / serverless cold starts.
const WARNING_HANDLER = Symbol.for("ai-workspace.process-warning-logger");
type WithSymbolFlag = NodeJS.Process & Record<symbol, boolean | undefined>;
if (!((process as WithSymbolFlag)[WARNING_HANDLER])) {
  (process as WithSymbolFlag)[WARNING_HANDLER] = true;
  process.on("warning", (warning) => {
    process.stderr.write(
      `[node-warning] ${JSON.stringify({
        name: warning.name,
        message: warning.message,
        stack: warning.stack,
      })}\n`,
    );
  });
}

interface ChatRequestBody {
  message: string;
  threadId?: string;
  modelId?: string;
}

type ChatRunStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

/**
 * POST /api/chat — single-turn chat against the agent loop.
 *
 * Body: { message, threadId?, modelId? }
 * Response: text/event-stream of `AgentEvent` objects (one per `data:` line).
 *           Final `data:` line includes the persisted threadId/messageId so
 *           the client can navigate to the thread.
 */
export async function POST(req: Request) {
  let sessionUser;
  try {
    sessionUser = await getSessionUser();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json(
      { error: "missing_message" },
      { status: 400 },
    );
  }

  if (body.message.length > limits.maxMessageChars) {
    return NextResponse.json(
      {
        error: "message_too_large",
        message: `Message must be ${limits.maxMessageChars} characters or fewer.`,
      },
      { status: 413 },
    );
  }

  // Accept any non-empty string for modelId. The runtime layer is the
  // source of truth on what's actually valid (it calls toCursorModelId,
  // which legacy-maps our short ids and passes Cursor ids through; the
  // SDK rejects unknown ids at the agent.send call).
  const modelId: string =
    typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId
      : DEFAULT_MODEL_ID;

  const db = getDb();

  const rate = checkRateLimit(`chat:${sessionUser.id}`, limits);
  if (!rate.allowed) {
    await db.insert(auditLog).values({
      actorUserId: sessionUser.id,
      actionType: "rate_limit",
      status: "denied",
      provider: "ai-hub",
      toolName: "chat",
      input: {
        route: "/api/chat",
        windowMs: limits.windowMs,
        maxRequests: limits.maxRequests,
      },
      error: "chat_rate_limit_exceeded",
      metadata: {
        retryAfterSeconds: rate.retryAfterSeconds,
        resetAt: rate.resetAt.toISOString(),
      },
      startedAt: new Date(),
      completedAt: new Date(),
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

  // The session carries (id, email, displayName, role); we still need
  // customInstructions for the agent preamble. One direct lookup against
  // the canonical users.id (which IS session.user.id, set in the JWT
  // callback) — no upsert needed.
  const userRows = await db
    .select({ customInstructions: users.customInstructions })
    .from(users)
    .where(eq(users.id, sessionUser.id))
    .limit(1);
  const customInstructions = userRows[0]?.customInstructions ?? null;

  let thread: ChatThread;
  if (body.threadId) {
    // Admin can resume any thread; users only their own. Persistence below
    // still writes against whatever thread is found, so an admin replying
    // into a user's thread will append messages to that user's thread row.
    const owned = await db
      .select()
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, body.threadId),
          userScope(sessionUser, chatThreads.userId),
        ),
      )
      .limit(1);
    if (!owned[0]) {
      return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
    }
    thread = owned[0];
  } else {
    const created = await db
      .insert(chatThreads)
      .values({
        userId: sessionUser.id,
        defaultModelId: modelId,
        title: deriveTitle(body.message),
      })
      .returning();
    thread = created[0]!;
  }

  const userMsg = await db
    .insert(chatMessages)
    .values({
      threadId: thread.id,
      role: "user",
      content: body.message,
    })
    .returning();

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
          userId: sessionUser.id,
          ...event,
        })}\n`,
      );
    },
  });

  const runtime = getRuntime({ db });

  // Per-user MCP servers from connected integrations (oauth_tokens).
  // Wrapped in its own try so an MCP plumbing problem can never tank the
  // chat — the user just doesn't get tools this turn.
  let mcpServers;
  let deniedMcpProviders: string[] = [];
  try {
    const mcpAccess = await buildUserMcpServers(db, sessionUser.id);
    mcpServers = mcpAccess.mcpServers;
    deniedMcpProviders = mcpAccess.deniedProviders;
  } catch (err) {
    console.warn("[mcp] buildUserMcpServers threw:", err);
    mcpServers = undefined;
    deniedMcpProviders = [];
  }

  if (deniedMcpProviders.length > 0) {
    await db.insert(auditLog).values(
      deniedMcpProviders.map((provider) => ({
        actorUserId: sessionUser.id,
        actionType: "mcp_tool_attestation",
        status: "denied" as const,
        provider,
        toolName: "*",
        chatThreadId: thread.id,
        input: { provider },
        error: `Tool provider "${provider}" is connected but has no active user attestation.`,
        metadata: { modelId, runtime: runtime.name },
        startedAt: new Date(),
        completedAt: new Date(),
      })),
    );
    process.stderr.write(
      `[mcp-attestation-denied] ${JSON.stringify({
        threadId: thread.id,
        userId: sessionUser.id,
        providers: deniedMcpProviders,
      })}\n`,
    );
  }

  // Steering preamble for fresh agents. The Cursor runtime includes it only
  // on the first thread turn so identity/custom-instruction steering does not
  // bloat every follow-up.
  const firstTurnPreamble = buildAgentPreamble({
    user: {
      displayName: sessionUser.displayName,
      customInstructions,
    },
    connectedProviders: mcpServers ? Object.keys(mcpServers) : [],
    blockedProviders: deniedMcpProviders,
  });

  // TEMP DEBUG: confirm what's reaching the runtime. stderr is usually
  // unbuffered in Node; console.log via Next.js standalone has been seen
  // to not flush to App Runner's CloudWatch group.
  process.stderr.write(
    `[mcp-debug:route] ${JSON.stringify({
      threadId: thread.id,
      userId: sessionUser.id,
      mcpServerKeys: mcpServers ? Object.keys(mcpServers) : [],
      deniedMcpProviders,
      preambleChars: firstTurnPreamble.length,
    })}\n`,
  );

  const chatRunStartedAt = new Date();
  const chatRunRows = await db
    .insert(recipeRuns)
    .values({
      userId: sessionUser.id,
      threadId: thread.id,
      recipeSlug: "chat-turn",
      triggerType: "chat",
      status: "running",
      runtime: runtime.name,
      modelId,
      inputs: {
        prompt: body.message,
        threadId: thread.id,
        userMessageId: userMsg[0]!.id,
        mcpProviders: mcpServers ? Object.keys(mcpServers) : [],
        deniedMcpProviders,
      },
      startedAt: chatRunStartedAt,
      updatedAt: chatRunStartedAt,
    })
    .returning({ id: recipeRuns.id });
  const chatRunId = chatRunRows[0]!.id;
  let runEventSequence = 0;
  const nextRunEventSequence = () => {
    runEventSequence += 1;
    return runEventSequence;
  };
  const appendChatRunEvent = async (
    input: Omit<AppendRunEventInput, "db" | "recipeRunId" | "sequence">,
  ) => {
    try {
      await appendRunEvent({
        db,
        recipeRunId: chatRunId,
        sequence: nextRunEventSequence(),
        ...input,
      });
    } catch (err) {
      process.stderr.write(
        `[chat-run-event-error] ${JSON.stringify({
          runId: chatRunId,
          threadId: thread.id,
          eventType: input.eventType,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  };
  await appendChatRunEvent({
    eventType: "run_started",
    status: "pending",
    label: "Started chat run",
    metadata: {
      threadId: thread.id,
      modelId,
      runtime: runtime.name,
      mcpProviders: mcpServers ? Object.keys(mcpServers) : [],
    },
  });

  const encoder = new TextEncoder();
  const runtimeAbort = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* stream was already closed by the client */
        }
      };
      const send = (obj: unknown): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
          );
          return true;
        } catch (err) {
          closed = true;
          process.stderr.write(
            `[chat-stream-closed] ${JSON.stringify({
              threadId: thread.id,
              message: err instanceof Error ? err.message : String(err),
            })}\n`,
          );
          return false;
        }
      };
      let assistantText = "";
      let tokensIn = 0;
      let tokensOut = 0;
      let providerRunMetadata: RuntimeRunMetadata | null = null;
      const runtimeErrors: string[] = [];
      const toolEvents = createToolEventAccumulator(
        mcpServers ? Object.keys(mcpServers) : [],
      );
      const buildChatRunOutput = (extra: Record<string, unknown> = {}) => ({
        assistantText,
        toolCalls: toolEvents.calls(),
        toolResults: toolEvents.results(),
        tokensIn,
        tokensOut,
        modelId,
        runtime: runtime.name,
        ...(providerRunMetadata ? { providerRun: providerRunMetadata } : {}),
        ...extra,
      });
      const updateChatRun = async (values: {
        status?: ChatRunStatus;
        outputs?: unknown;
        error?: string | null;
        completedAt?: Date | null;
      }) => {
        try {
          await db
            .update(recipeRuns)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(recipeRuns.id, chatRunId));
        } catch (err) {
          process.stderr.write(
            `[chat-run-update-error] ${JSON.stringify({
              runId: chatRunId,
              threadId: thread.id,
              message: err instanceof Error ? err.message : String(err),
            })}\n`,
          );
        }
      };

      // Tell the client which thread/run this turn is on, before model output.
      if (!send({
        type: "meta",
        threadId: thread.id,
        runId: chatRunId,
        userMessageId: userMsg[0]!.id,
        modelId,
      })) {
        await updateChatRun({
          status: "canceled",
          error: "Client disconnected before the run started.",
          completedAt: new Date(),
        });
        await appendChatRunEvent({
          eventType: "run_disconnected",
          status: "failed",
          label: "Browser disconnected before the run started",
        });
        close();
        return;
      }
      const heartbeat = setInterval(() => {
        send({ type: "heartbeat", at: new Date().toISOString() });
      }, 15_000);
      const runtimeTimeout = setTimeout(
        () => {
          runtimeAbort.abort();
          process.stderr.write(
            `[chat-run-timeout] ${JSON.stringify({
              threadId: thread.id,
              userId: sessionUser.id,
              modelId,
              timeoutMs: CHAT_RUNTIME_TIMEOUT_MS,
            })}\n`,
          );
        },
        CHAT_RUNTIME_TIMEOUT_MS,
      );
      runtimeTimeout.unref?.();

      try {
        for await (const ev of runtime.runTurn({
          threadId: thread.id,
          modelId,
          messages: agentMessages,
          context: { userId: sessionUser.id },
          signal: runtimeAbort.signal,
          firstTurnPreamble,
          onRunStarted: async (metadata) => {
            providerRunMetadata = metadata;
            await updateChatRun({
              outputs: buildChatRunOutput({
                lifecycle: "provider_started",
                providerRun: metadata,
              }),
            });
            await appendChatRunEvent({
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
                recipeRunId: chatRunId,
                sequence: nextRunEventSequence(),
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
                recipeRunId: chatRunId,
                sequence: nextRunEventSequence(),
                call: persistedCall,
                result: persistedResult,
              });
            }
          } else if (ev.type === "error") {
            runtimeErrors.push(ev.message);
            // Yielded error events go to SSE without the route's try/catch
            // ever firing. Mirror to stderr so CloudWatch sees them too.
            process.stderr.write(
              `[chat-error:event] ${JSON.stringify({
                threadId: thread.id,
                userId: sessionUser.id,
                modelId,
                mcpKeys: mcpServers ? Object.keys(mcpServers) : [],
                message: ev.message,
              })}\n`,
            );
          }
          send(ev);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        process.stderr.write(
          `[chat-error] ${JSON.stringify({
            threadId: thread.id,
            userId: sessionUser.id,
            modelId,
            mcpKeys: mcpServers ? Object.keys(mcpServers) : [],
            message: msg,
            stack,
          })}\n`,
        );
        send({ type: "error", message: msg });
        await updateChatRun({
          status: "failed",
          error: msg,
          outputs: buildChatRunOutput({ failureSite: "runtime" }),
          completedAt: new Date(),
        });
        await appendChatRunEvent({
          eventType: "run_failed",
          status: "failed",
          label: "Run failed",
          error: msg,
          metadata: { failureSite: "runtime" },
        });
        close();
        return;
      } finally {
        clearInterval(heartbeat);
        clearTimeout(runtimeTimeout);
      }

      // Anything that throws after the runtime loop ends (DB persist, etc.)
      // would otherwise tear down the ReadableStream with no detail — the
      // browser surfaces that as a generic "Load failed". Catch it, mirror
      // to stderr with the same `[chat-error]` tag the route uses elsewhere,
      // and send the detail to the client as an `error` SSE event.
      try {
        const timeoutError = runtimeAbort.signal.aborted
          ? `Chat runtime timed out after ${CHAT_RUNTIME_TIMEOUT_MS}ms.`
          : null;
        const runError =
          timeoutError ?? (runtimeErrors.length > 0 ? runtimeErrors.join("\n") : null);
        const persisted = await db
          .insert(chatMessages)
          .values({
            threadId: thread.id,
            role: "assistant",
            content: assistantText,
            modelId,
            runtime: runtime.name,
            tokensIn,
            tokensOut,
            toolCalls: toolEvents.calls(),
            toolResults: toolEvents.results(),
          })
          .returning();
        const assistantMessageId = persisted[0]!.id;
        const toolAuditRows = buildToolAuditRows({
          actorUserId: sessionUser.id,
          chatThreadId: thread.id,
          chatMessageId: assistantMessageId,
          recipeRunId: chatRunId,
          modelId,
          runtime: runtime.name,
          calls: toolEvents.calls(),
          results: toolEvents.results(),
        });

        if (toolAuditRows.length > 0) {
          await db.insert(auditLog).values(toolAuditRows);
        }

        await db
          .update(chatThreads)
          .set({ updatedAt: new Date() })
          .where(eq(chatThreads.id, thread.id));

        await updateChatRun({
          status: runError ? "failed" : "succeeded",
          error: runError,
          outputs: buildChatRunOutput({
            assistantMessageId,
            userMessageId: userMsg[0]!.id,
          }),
          completedAt: new Date(),
        });
        await appendChatRunEvent({
          eventType: runError ? "run_failed" : "run_completed",
          status: runError ? "failed" : "succeeded",
          label: runError ? "Run ended with errors" : "Stored assistant answer",
          ...(runError ? { error: runError } : {}),
          metadata: { assistantMessageId, userMessageId: userMsg[0]!.id },
        });

        send({
          type: "persisted",
          assistantMessageId,
          threadId: thread.id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        process.stderr.write(
          `[chat-error] ${JSON.stringify({
            site: "persist",
            threadId: thread.id,
            userId: sessionUser.id,
            modelId,
            message: msg,
            stack,
          })}\n`,
        );
        await updateChatRun({
          status: "failed",
          error: msg,
          outputs: buildChatRunOutput({ failureSite: "persist" }),
          completedAt: new Date(),
        });
        await appendChatRunEvent({
          eventType: "run_failed",
          status: "failed",
          label: "Could not store assistant answer",
          error: msg,
          metadata: { failureSite: "persist" },
        });
        send({ type: "error", message: msg });
      }

      close();
    },
    cancel() {
      // Browser/App Runner disconnects must not cancel the underlying agent
      // work. App Runner has a hard 120s HTTP request limit; long research
      // runs should still be allowed to finish and persist to the thread so
      // the user can reopen the chat history and see the result.
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

const TITLE_MAX = 60;
function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.replace(/\s+/g, " ").trim();
  if (trimmed.length <= TITLE_MAX) return trimmed;
  return trimmed.slice(0, TITLE_MAX - 1) + "…";
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
