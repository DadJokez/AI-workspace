import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { AuthConfigError } from "@ai-workspace/auth";
import {
  auditLog,
  type ChatThread,
  chatMessages,
  chatThreads,
  getDb,
  recipeRuns,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";
import { parseChatExecutionMode } from "@/lib/chat-execution-mode";
import { decideChatRuntimeRoute } from "@/lib/chat-routing";
import { streamInlineChatRun } from "@/lib/chat-inline-runner";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import {
  checkRateLimit,
  contentLengthTooLarge,
  requestLimitConfig,
} from "@/lib/request-limits";
import { appendRunEvent } from "@/lib/run-events";

export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message: string;
  threadId?: string;
  modelId?: string;
  executionMode?: string;
}

/**
 * POST /api/chat accepts a chat turn, persists the user message, then chooses
 * the lightest runtime lane that can satisfy the request. Simple turns stream
 * inline. Durable/cloud work is queued for the background worker.
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
    return NextResponse.json({ error: "missing_message" }, { status: 400 });
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

  const modelId: string =
    typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId
      : DEFAULT_MODEL_ID;
  const executionMode = parseChatExecutionMode(body.executionMode);
  const runtimeRoute = decideChatRuntimeRoute({
    message: body.message,
    executionMode,
  });

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

  let thread: ChatThread;
  if (body.threadId) {
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
    .returning({ id: chatMessages.id });

  const queuedAt = new Date();
  await db
    .update(chatThreads)
    .set({ updatedAt: queuedAt })
    .where(eq(chatThreads.id, thread.id));

  const chatRunStartedAt = runtimeRoute.useWorker ? null : queuedAt;
  const chatRunRows = await db
    .insert(recipeRuns)
    .values({
      userId: sessionUser.id,
      threadId: thread.id,
      recipeSlug: "chat-turn",
      triggerType: "chat",
      status: runtimeRoute.useWorker ? "queued" : "running",
      modelId,
      inputs: {
        prompt: body.message,
        threadId: thread.id,
        userMessageId: userMsg[0]!.id,
        requestedByUserId: sessionUser.id,
        executionMode: runtimeRoute.executionMode,
        runtimeRoute,
      },
      attemptCount: runtimeRoute.useWorker ? 0 : 1,
      startedAt: chatRunStartedAt,
      lastHeartbeatAt: chatRunStartedAt,
      updatedAt: queuedAt,
    })
    .returning({ id: recipeRuns.id });
  const chatRunId = chatRunRows[0]!.id;

  try {
    await appendRunEvent({
      db,
      recipeRunId: chatRunId,
      sequence: 1,
      eventType: runtimeRoute.useWorker ? "run_queued" : "run_started",
      status: "pending",
      label: runtimeRoute.useWorker
        ? "Queued durable chat run"
        : "Started local streaming chat run",
      metadata: {
        threadId: thread.id,
        modelId,
        userMessageId: userMsg[0]!.id,
        executionMode: runtimeRoute.executionMode,
        runtimeRoute,
      },
      occurredAt: queuedAt,
    });
  } catch (err) {
    process.stderr.write(
      `[chat-run-event-error] ${JSON.stringify({
        runId: chatRunId,
        threadId: thread.id,
        eventType: "run_queued",
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }

  if (runtimeRoute.useWorker) {
    startInProcessChatRunWorker({ db, runId: chatRunId });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      send({
        type: "meta",
        threadId: thread.id,
        runId: chatRunId,
        userMessageId: userMsg[0]!.id,
        modelId,
        executionMode: runtimeRoute.executionMode,
        runtimeRoute,
      });
      if (runtimeRoute.useWorker) {
        send({
          type: "queued",
          threadId: thread.id,
          runId: chatRunId,
          status:
            runtimeRoute.lane === "cursor-cloud"
              ? "Queued for Cursor Cloud worker"
              : "Queued for durable worker",
        });
        controller.close();
        return;
      }

      try {
        await streamInlineChatRun({
          db,
          runId: chatRunId,
          thread,
          userId: sessionUser.id,
          userMessageId: userMsg[0]!.id,
          prompt: body.message,
          modelId,
          route: runtimeRoute,
          signal: req.signal,
          send,
        });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
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
  return trimmed.slice(0, TITLE_MAX - 1) + "...";
}
