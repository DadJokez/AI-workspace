import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { AuthConfigError } from "@ai-workspace/auth";
import { getRuntime } from "@ai-workspace/cursor-runtime";
import {
  type ChatThread,
  chatMessages,
  chatThreads,
  getDb,
} from "@ai-workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import { getCurrentUser } from "@/lib/auth/session";
import { userScope } from "@/lib/auth/scope";
import { buildUserMcpServers } from "@/lib/oauth/mcp-servers";
import { ensureUser } from "@/lib/users";

export const dynamic = "force-dynamic";

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

/**
 * POST /api/chat — single-turn chat against the agent loop.
 *
 * Body: { message, threadId?, modelId? }
 * Response: text/event-stream of `AgentEvent` objects (one per `data:` line).
 *           Final `data:` line includes the persisted threadId/messageId so
 *           the client can navigate to the thread.
 */
export async function POST(req: Request) {
  let authUser;
  try {
    authUser = await getCurrentUser(req);
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!authUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  // Accept any non-empty string for modelId. The runtime layer is the
  // source of truth on what's actually valid (it calls toCursorModelId,
  // which legacy-maps our short ids and passes Cursor ids through; the
  // SDK rejects unknown ids at the agent.send call).
  const modelId: string =
    typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId
      : DEFAULT_MODEL_ID;

  const dbUser = await ensureUser(authUser);
  const db = getDb();

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
          userScope(dbUser, chatThreads.userId),
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
        userId: dbUser.id,
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

  const agentMessages = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const runtime = getRuntime({ db });

  // Per-user MCP servers from connected integrations (oauth_tokens).
  // Wrapped in its own try so an MCP plumbing problem can never tank the
  // chat — the user just doesn't get tools this turn.
  let mcpServers;
  try {
    mcpServers = await buildUserMcpServers(db, dbUser.id);
  } catch (err) {
    console.warn("[mcp] buildUserMcpServers threw:", err);
    mcpServers = undefined;
  }

  // Steering preamble for fresh agents (first turn only). The runtime
  // ignores this on resumed agents, so it's safe to send unconditionally.
  const firstTurnPreamble = buildAgentPreamble({
    user: {
      displayName: dbUser.displayName,
      customInstructions: dbUser.customInstructions,
    },
    connectedProviders: mcpServers ? Object.keys(mcpServers) : [],
  });

  // TEMP DEBUG: confirm what's reaching the runtime. stderr is usually
  // unbuffered in Node; console.log via Next.js standalone has been seen
  // to not flush to App Runner's CloudWatch group.
  process.stderr.write(
    `[mcp-debug:route] ${JSON.stringify({
      threadId: thread.id,
      userId: dbUser.id,
      mcpServerKeys: mcpServers ? Object.keys(mcpServers) : [],
      preambleChars: firstTurnPreamble.length,
    })}\n`,
  );

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      // Tell the client which thread this turn is on, before model output.
      send({
        type: "meta",
        threadId: thread.id,
        userMessageId: userMsg[0]!.id,
        modelId,
      });

      let assistantText = "";
      let tokensIn = 0;
      let tokensOut = 0;

      try {
        for await (const ev of runtime.runTurn({
          threadId: thread.id,
          modelId,
          messages: agentMessages,
          context: { userId: dbUser.id },
          signal: abort.signal,
          firstTurnPreamble,
          ...(mcpServers ? { mcpServers } : {}),
        })) {
          if (ev.type === "text-delta") {
            assistantText += ev.delta;
          } else if (ev.type === "usage") {
            tokensIn = ev.tokensIn;
            tokensOut = ev.tokensOut;
          } else if (ev.type === "error") {
            // Yielded error events go to SSE without the route's try/catch
            // ever firing. Mirror to stderr so CloudWatch sees them too.
            process.stderr.write(
              `[chat-error:event] ${JSON.stringify({
                threadId: thread.id,
                userId: dbUser.id,
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
            userId: dbUser.id,
            modelId,
            mcpKeys: mcpServers ? Object.keys(mcpServers) : [],
            message: msg,
            stack,
          })}\n`,
        );
        send({ type: "error", message: msg });
        controller.close();
        return;
      }

      // Anything that throws after the runtime loop ends (DB persist, etc.)
      // would otherwise tear down the ReadableStream with no detail — the
      // browser surfaces that as a generic "Load failed". Catch it, mirror
      // to stderr with the same `[chat-error]` tag the route uses elsewhere,
      // and send the detail to the client as an `error` SSE event.
      try {
        const persisted = await db
          .insert(chatMessages)
          .values({
            threadId: thread.id,
            role: "assistant",
            content: assistantText,
            modelId,
            tokensIn,
            tokensOut,
          })
          .returning();

        await db
          .update(chatThreads)
          .set({ updatedAt: new Date() })
          .where(eq(chatThreads.id, thread.id));

        send({
          type: "persisted",
          assistantMessageId: persisted[0]!.id,
          threadId: thread.id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        process.stderr.write(
          `[chat-error] ${JSON.stringify({
            site: "persist",
            threadId: thread.id,
            userId: dbUser.id,
            modelId,
            message: msg,
            stack,
          })}\n`,
        );
        send({ type: "error", message: msg });
      }

      controller.close();
    },
    cancel() {
      abort.abort();
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
