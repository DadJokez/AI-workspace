import {
  DEFAULT_MODEL_ID,
  type ModelId,
  isValidModelId,
} from "@ai-workspace/agent";
import { AuthConfigError, getCurrentUser } from "@ai-workspace/auth";
import { getRuntime } from "@ai-workspace/cursor-runtime";
import {
  type ChatThread,
  chatMessages,
  chatThreads,
  getDb,
} from "@ai-workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureUser } from "@/lib/users";

export const dynamic = "force-dynamic";

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

  const modelId: ModelId =
    body.modelId && isValidModelId(body.modelId) ? body.modelId : DEFAULT_MODEL_ID;

  const dbUser = await ensureUser(authUser);
  const db = getDb();

  let thread: ChatThread;
  if (body.threadId) {
    const owned = await db
      .select()
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, body.threadId),
          eq(chatThreads.userId, dbUser.id),
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
        })) {
          if (ev.type === "text-delta") {
            assistantText += ev.delta;
          } else if (ev.type === "usage") {
            tokensIn = ev.tokensIn;
            tokensOut = ev.tokensOut;
          }
          send(ev);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: "error", message: msg });
        controller.close();
        return;
      }

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
