import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { AuthConfigError } from "@ai-workspace/auth";
import {
  auditLog,
  type ChatThread,
  chatMessages,
  chatThreads,
  getDb,
  runs,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";
import { parseChatExecutionMode } from "@/lib/chat-execution-mode";
import {
  buildChatRouteReceipt,
  decideChatRuntimeRoute,
  runtimeV2EnabledFromEnv,
} from "@/lib/chat-routing";
import { streamInlineChatRun } from "@/lib/chat-inline-runner";
import {
  foldAttachmentsIntoPrompt,
  scanAttachmentsForSecrets,
  validateAttachments,
  type ChatAttachment,
} from "@/lib/attachments";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import {
  checkRateLimit,
  contentLengthTooLarge,
  requestLimitConfig,
} from "@/lib/request-limits";
import { appendRunEvent } from "@/lib/run-events";
import { loadUserMcpProviderStatus } from "@/lib/oauth/mcp-servers";

export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message: string;
  threadId?: string;
  modelId?: string;
  executionMode?: string;
  attachments?: ChatAttachment[];
}

/**
 * POST /api/chat accepts a chat turn, persists the user message, then chooses
 * the lightest runtime lane that can satisfy the request. Simple turns stream
 * inline. Durable work is queued for the AgentCore-backed worker.
 */
export async function POST(req: Request) {
  const requestStartedAt = new Date();
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

  const attachmentCheck = await validateAttachments(body.attachments);
  if (!attachmentCheck.ok) {
    return NextResponse.json(
      { error: "invalid_attachments", message: attachmentCheck.error },
      { status: 400 },
    );
  }
  const attachments = attachmentCheck.attachments;

  const modelId: string =
    typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId
      : DEFAULT_MODEL_ID;
  const executionMode = parseChatExecutionMode(body.executionMode);
  const runtimeV2 = runtimeV2EnabledFromEnv();

  const db = getDb();
  const rate = await checkRateLimit(db, `chat:${sessionUser.id}`, limits);
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

  // Earlier user turns in this thread, so routing can keep tools mounted for
  // follow-ups once a conversation has used them (conversation-level tool
  // stickiness). Queried before inserting the current message so it sees only
  // priors. New threads have none.
  const priorUserMessages = body.threadId
    ? (
        await db
          .select({ content: chatMessages.content })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.threadId, thread.id),
              eq(chatMessages.role, "user"),
            ),
          )
          .orderBy(desc(chatMessages.createdAt))
          .limit(6)
      ).map((row) => row.content)
    : [];

  const routingProviderStatus = await loadUserMcpProviderStatus(db, sessionUser.id);
  const contextSignals = {
    priorUserMessagesCount: priorUserMessages.length,
    uploadedFilesAvailable: attachments.length > 0,
  };
  const capabilitySignals = {
    connectedProviders: routingProviderStatus.connectedProviders,
    approvedProviders: routingProviderStatus.allowedProviders,
    pendingApprovalProviders: routingProviderStatus.deniedProviders,
  };
  const runtimeRoute = decideChatRuntimeRoute({
    message: body.message,
    executionMode,
    runtimeV2,
    priorUserMessages,
    contextSignals,
    capabilitySignals,
  });
  const routeReceipt = buildChatRouteReceipt({
    route: runtimeRoute,
    contextSignals,
    capabilitySignals,
  });

  const userMsg = await db
    .insert(chatMessages)
    .values({
      threadId: thread.id,
      role: "user",
      content: body.message,
    })
    .returning({ id: chatMessages.id });

  // The bubble shows the typed message; the model sees it plus the folded
  // attachment text. Each file is also stored as a workspace artifact so it
  // renders as a chip on the turn (and is downloadable later).
  const promptForModel = foldAttachmentsIntoPrompt(body.message, attachments);
  const uploadedFiles = attachments.map((a) => ({
    name: a.name,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    extractionStatus: a.extractionStatus,
    ...(a.runtimeContent ? { runtimeContent: a.runtimeContent } : {}),
  }));
  if (attachments.length > 0) {
    const secretFindings = scanAttachmentsForSecrets(attachments);
    await db.insert(workspaceArtifacts).values(
      attachments.map((a) => ({
        userId: sessionUser.id,
        threadId: thread.id,
        chatMessageId: userMsg[0]!.id,
        title: a.name,
        filename: a.name,
        kind: a.kind,
        mimeType: a.mimeType,
        content: a.storageContent,
        sizeBytes: a.sizeBytes,
        source: "user-upload",
        metadata: {
          storageEncoding: a.storageEncoding,
          extractionStatus: a.extractionStatus,
          extractedText: a.content,
          ...(a.extractionNotes?.length ? { extractionNotes: a.extractionNotes } : {}),
          ...(a.image ? { image: a.image } : {}),
          ...(secretFindings.length > 0 ? { secretWarning: secretFindings } : {}),
        },
      })),
    );
  }

  const queuedAt = new Date();
  await db
    .update(chatThreads)
    .set({ updatedAt: queuedAt })
    .where(eq(chatThreads.id, thread.id));

  const chatRunStartedAt = runtimeRoute.useWorker ? null : queuedAt;
  const chatRunRows = await db
    .insert(runs)
    .values({
      userId: sessionUser.id,
      threadId: thread.id,
      skillSlug: "chat-turn",
      triggerType: "chat",
      status: runtimeRoute.useWorker ? "queued" : "running",
      modelId,
      inputs: {
        prompt: promptForModel,
        threadId: thread.id,
        userMessageId: userMsg[0]!.id,
        requestedByUserId: sessionUser.id,
        executionMode: runtimeRoute.executionMode,
        runtimeV2,
        runtimeRoute,
        uploadedFiles,
        routeReceipt,
      },
      attemptCount: runtimeRoute.useWorker ? 0 : 1,
      startedAt: chatRunStartedAt,
      lastHeartbeatAt: chatRunStartedAt,
      updatedAt: queuedAt,
    })
    .returning({ id: runs.id });
  const chatRunId = chatRunRows[0]!.id;

  try {
    await appendRunEvent({
      db,
      runId: chatRunId,
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
        runtimeV2,
        runtimeRoute,
        routeReceipt,
      },
      occurredAt: queuedAt,
    });
    if (attachments.length > 0) {
      await appendRunEvent({
        db,
        runId: chatRunId,
        sequence: 2,
        eventType: "uploaded_files_stored",
        status: "succeeded",
        label: `Stored ${attachments.length} uploaded file${attachments.length === 1 ? "" : "s"}`,
        metadata: { uploadedFiles },
        occurredAt: queuedAt,
      });
    }
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
        runtimeV2,
        runtimeRoute,
        routeReceipt,
      });
      if (runtimeRoute.useWorker) {
        send({
          type: "queued",
          threadId: thread.id,
          runId: chatRunId,
          status: "Queued for AgentCore worker",
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
          prompt: promptForModel,
          modelId,
          route: runtimeRoute,
          requestStartedAt,
          uploadedFiles,
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
