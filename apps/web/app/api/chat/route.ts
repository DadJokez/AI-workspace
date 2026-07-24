import { DEFAULT_MODEL_ID, normalizeUserTimeZone } from "@ai-workspace/agent";
import {
  auditLog,
  type ChatThread,
  chatMessages,
  chatThreads,
  getDb,
  runs,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { parseChatExecutionMode } from "@/lib/chat-execution-mode";
import {
  applyActivatedSkillRoute,
  buildChatRouteReceipt,
  decideChatRuntimeRoute,
} from "@/lib/chat-routing";
import { loadUserCapabilityGraph } from "@/lib/capability-graph";
import {
  resolveActivatedSkillForChat,
  type ActivatedSkillForChat,
  type ActivatedSkillRequest,
} from "@/lib/chat-activated-skills";
import { buildActivatedSkillUserMessage } from "@/lib/skills";
import { skillMcpProviders } from "@/lib/skill-tool-declarations";
import { streamInlineChatRun } from "@/lib/chat-inline-runner";
import {
  createChatStreamWriter,
  startChatStreamHeartbeat,
} from "@/lib/chat-stream-contract";
import { isModelEnabled, resolveModelForPurpose } from "@/lib/model-registry";
import {
  resolveDeclaredAttachmentCount,
  scanAttachmentsForSecrets,
  validateAttachments,
  type ChatAttachment,
  type PreparedChatAttachment,
} from "@/lib/attachments";
import {
  reconstructStoredAttachments,
} from "@/lib/attachment-replay";
import {
  conversationResourceMetadata,
  loadPreviousConversationResourceResolution,
  loadThreadConversationResources,
  preparePendingConversationResources,
  resolveConversationResources,
} from "@/lib/conversation-resources";
import { buildConversationResourcePrompt } from "@/lib/conversation-resource-prompt";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";
import {
  checkRateLimit,
  contentLengthTooLarge,
  requestLimitConfig,
} from "@/lib/request-limits";
import { appendRunEvent } from "@/lib/run-events";
import {
  isModelCommandInput,
  modelCommandUsageMessage,
  parseModelCommand,
} from "@/lib/model-command";
import { resolveChatModelPreference } from "@/lib/runtime-model-policy";
import {
  isChatMessageEditId,
  planChatMessageEdit,
} from "@/lib/chat-message-edit";
import { capturePostHogEvent } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message: string;
  threadId?: string;
  modelId?: string;
  modelOverride?: boolean;
  executionMode?: string;
  activatedSkills?: ActivatedSkillRequest[];
  attachments?: ChatAttachment[];
  attachmentCount?: number;
  replaceMessageId?: string;
  /** Browser-reported IANA timezone (#432); validated server-side. */
  timeZone?: string;
}

/**
 * POST /api/chat accepts a chat turn, persists the user message, then chooses
 * the lightest runtime lane that can satisfy the request. Simple turns stream
 * inline. Durable work is queued for the AgentCore-backed worker.
 */
export async function POST(req: Request) {
  const requestStartedAt = new Date();
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

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

  const replaceMessageId =
    typeof body.replaceMessageId === "string" && body.replaceMessageId.trim()
      ? body.replaceMessageId.trim()
      : undefined;
  if (
    body.replaceMessageId !== undefined &&
    (!replaceMessageId || !isChatMessageEditId(replaceMessageId))
  ) {
    return NextResponse.json(
      { error: "invalid_replace_message_id" },
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

  const modelCommand = parseModelCommand(body.message);
  if (isModelCommandInput(body.message) && !modelCommand) {
    return NextResponse.json(
      { error: "invalid_model_command", message: modelCommandUsageMessage() },
      { status: 400 },
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
  if (modelCommand && !modelCommand.body.trim() && attachments.length === 0) {
    return NextResponse.json(
      { error: "invalid_model_command", message: modelCommandUsageMessage() },
      { status: 400 },
    );
  }
  const effectiveUserMessage = modelCommand?.body ?? body.message;
  // #430: max(count field, text note) — an explicit attachmentCount: 0
  // must not defeat a message that visibly declares attached files.
  const declaredAttachmentCount = resolveDeclaredAttachmentCount(
    body.attachmentCount,
    body.message,
  );
  const receivedAttachmentCount =
    attachmentCheck.receivedAttachmentCount ?? attachments.length;
  if (declaredAttachmentCount > receivedAttachmentCount) {
    return NextResponse.json(
      {
        error: "missing_attachment_payload",
        message:
          "The chat saw attached files in the composer, but the browser did not send the file data. Refresh the page, re-attach the files, and send again.",
      },
      { status: 409 },
    );
  }

  const requestedModelId: string =
    modelCommand?.override.mode === "model"
      ? modelCommand.override.modelId
      : typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId
      : DEFAULT_MODEL_ID;
  const modelOverride =
    modelCommand?.override.mode === "model" || body.modelOverride === true;
  const executionMode = parseChatExecutionMode(body.executionMode);
  // #432: the browser's timezone grounds "today"/"tomorrow" for interactive
  // turns. Anything that is not a real IANA zone is treated as absent — an
  // arbitrary request string must never reach the prompt.
  const userTimeZone = normalizeUserTimeZone(body.timeZone);

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

  const activatedSkillResult = await resolveActivatedSkillForChat({
    db,
    actor: sessionUser,
    activatedSkills: body.activatedSkills,
  });
  if (!activatedSkillResult.ok) {
    return NextResponse.json(
      {
        error: activatedSkillResult.error,
        message: activatedSkillResult.message,
      },
      { status: activatedSkillResult.status },
    );
  }
  const activatedSkill = activatedSkillResult.activatedSkill;
  // #300: a model disabled for user-facing chat can never be selected — not
  // via /model, the request body, or a stale skill pin. Disabled or unknown
  // ids resolve to the enabled default instead.
  const modelPreference = resolveChatModelPreference({
    requestedModelId,
    modelOverride,
    skillModelId: activatedSkill?.skill.modelId,
  });
  const requestedOrPinnedModelId = modelPreference.modelId;
  const modelId = (await isModelEnabled(db, requestedOrPinnedModelId, "chat"))
    ? requestedOrPinnedModelId
    : await resolveModelForPurpose(db, "chat");

  let thread: ChatThread;
  if (body.threadId) {
    // Posting a message MUTATES the thread, so this is owner-scoped with no
    // admin bypass — userScope() is read-side only per its own contract, and
    // using it here let admins write into other users' threads (#445).
    const owned = await db
      .select()
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, body.threadId),
          eq(chatThreads.userId, sessionUser.id),
        ),
      )
      .limit(1);
    if (!owned[0]) {
      return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
    }
    thread = owned[0];
  } else {
    if (replaceMessageId) {
      return NextResponse.json(
        { error: "thread_required_for_edit" },
        { status: 400 },
      );
    }
    const created = await db
      .insert(chatThreads)
      .values({
        userId: sessionUser.id,
        defaultModelId: modelId,
        title: deriveThreadTitle(
          effectiveUserMessage || body.message,
          activatedSkill,
        ),
      })
      .returning();
    thread = created[0]!;
  }

  let editCandidateRows:
    | Array<{
        id: string;
        role: "user" | "assistant" | "tool";
        content: string;
      }>
    | undefined;
  let replayedAttachments: PreparedChatAttachment[] | undefined;
  let replayedArtifactIds: string[] | undefined;
  if (replaceMessageId) {
    if (thread.userId !== sessionUser.id) {
      return NextResponse.json({ error: "message_not_found" }, { status: 404 });
    }
    editCandidateRows = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, thread.id))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    const editPlan = planChatMessageEdit(editCandidateRows, replaceMessageId);
    if (!editPlan.ok) {
      return NextResponse.json(
        { error: editPlan.error },
        { status: editPlan.error === "message_not_found" ? 404 : 409 },
      );
    }
    // #348: a file-bearing turn edits by replaying its stored uploads.
    // Reconstruction fails closed — anything short of the full original
    // payload keeps the follow-up-only behavior.
    const attachedRows = await db
      .select({
        id: workspaceArtifacts.id,
        title: workspaceArtifacts.title,
        filename: workspaceArtifacts.filename,
        kind: workspaceArtifacts.kind,
        mimeType: workspaceArtifacts.mimeType,
        content: workspaceArtifacts.content,
        sizeBytes: workspaceArtifacts.sizeBytes,
        metadata: workspaceArtifacts.metadata,
        source: workspaceArtifacts.source,
      })
      .from(workspaceArtifacts)
      .where(eq(workspaceArtifacts.chatMessageId, editPlan.targetId))
      .orderBy(asc(workspaceArtifacts.createdAt), asc(workspaceArtifacts.id));
    if (attachedRows.length > 0) {
      if (attachments.length > 0) {
        return NextResponse.json(
          {
            error: "attachments_conflict_with_replay",
            message:
              "Editing this message re-sends its original files. Remove the newly attached files, or send them in a new message.",
          },
          { status: 400 },
        );
      }
      const uploads = attachedRows.filter(
        (row) => row.source === "user-upload",
      );
      const replay =
        uploads.length === attachedRows.length
          ? reconstructStoredAttachments(uploads)
          : ({ ok: false, reason: "non_upload_artifact_attached" } as const);
      if (!replay.ok) {
        return NextResponse.json(
          {
            error: "message_has_attachments",
            message:
              "Messages with uploaded files cannot be edited yet. Send a new follow-up instead.",
          },
          { status: 409 },
        );
      }
      replayedAttachments = replay.attachments;
      replayedArtifactIds = replay.resourceIds;
    }
  }

  // Earlier user turns in this thread, so routing can keep tools mounted for
  // follow-ups once a conversation has used them (conversation-level tool
  // stickiness). Queried before inserting the current message so it sees only
  // priors. New threads have none.
  const editTargetIndex =
    editCandidateRows && replaceMessageId
      ? editCandidateRows.findIndex((row) => row.id === replaceMessageId)
      : -1;
  let priorUserMessages: string[] = [];
  if (editCandidateRows && editTargetIndex >= 0) {
    priorUserMessages = editCandidateRows
      .slice(0, editTargetIndex)
      .filter((row) => row.role === "user")
      .reverse()
      .slice(0, 6)
      .map((row) => row.content);
  } else if (body.threadId) {
    priorUserMessages = (
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
    ).map((row) => row.content);
  }

  const requestAttachments = replayedAttachments ?? attachments;
  const pendingResources =
    attachments.length > 0
      ? preparePendingConversationResources(attachments)
      : [];
  const [storedResources, previousResourceResolution] = await Promise.all([
    loadThreadConversationResources({
      db,
      userId: sessionUser.id,
      threadId: thread.id,
    }),
    loadPreviousConversationResourceResolution({
      db,
      userId: sessionUser.id,
      threadId: thread.id,
    }),
  ]);
  const currentResourceIds =
    pendingResources.length > 0
      ? pendingResources.map((resource) => resource.id)
      : replayedArtifactIds ?? [];
  const resourceResolution = resolveConversationResources({
    message: effectiveUserMessage,
    resources: [
      ...pendingResources.map((resource) => resource.manifest),
      ...storedResources,
    ],
    currentResourceIds,
    previousResolution: previousResourceResolution,
  });
  // Only files on THIS request need runtime content (for example native image
  // bytes). Durable and current queryable files use compact resource ids.
  const effectiveAttachments = requestAttachments;

  const routingCapabilityGraph = await loadUserCapabilityGraph(db, sessionUser, {
    mountedProviders: [],
  });
  const contextSignals = {
    priorUserMessagesCount: priorUserMessages.length,
    uploadedFilesAvailable:
      effectiveAttachments.length > 0 ||
      resourceResolution.selected.length > 0,
  };
  let runtimeRoute = decideChatRuntimeRoute({
    message: effectiveUserMessage,
    executionMode,
    priorUserMessages,
    capabilityGraph: routingCapabilityGraph,
  });
  if (activatedSkill) {
    runtimeRoute = applyActivatedSkillRoute(runtimeRoute, {
      requiredProviders: skillMcpProviders(activatedSkill.skill.mcpProviders),
    });
  }
  const routeReceipt = buildChatRouteReceipt({
    route: runtimeRoute,
    contextSignals,
    capabilityGraph: routingCapabilityGraph,
  });

  let editedUserMessageId: string | undefined;
  if (replaceMessageId) {
    const editResult = await db.transaction(async (tx) => {
      const messageRows = await tx
        .select({ id: chatMessages.id, role: chatMessages.role })
        .from(chatMessages)
        .where(eq(chatMessages.threadId, thread.id))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
      const plan = planChatMessageEdit(messageRows, replaceMessageId);
      if (!plan.ok) return plan;

      // #348: the artifact set must match what reconstruction saw before
      // the transaction (empty for text-only turns). Anything else appearing
      // or disappearing means the replay payload is stale — fail closed.
      const attachedNow = await tx
        .select({ id: workspaceArtifacts.id })
        .from(workspaceArtifacts)
        .where(eq(workspaceArtifacts.chatMessageId, plan.targetId));
      const expectedArtifactIds = new Set(replayedArtifactIds ?? []);
      if (
        attachedNow.length !== expectedArtifactIds.size ||
        attachedNow.some((row) => !expectedArtifactIds.has(row.id))
      ) {
        return { ok: false as const, error: "message_has_attachments" as const };
      }

      if (plan.deleteIds.length > 0) {
        await tx
          .delete(chatMessages)
          .where(
            and(
              eq(chatMessages.threadId, thread.id),
              inArray(chatMessages.id, plan.deleteIds),
            ),
          );
      }
      await tx
        .update(chatMessages)
        .set({ content: body.message })
        .where(
          and(
            eq(chatMessages.id, plan.targetId),
            eq(chatMessages.threadId, thread.id),
            eq(chatMessages.role, "user"),
          ),
        );
      await tx
        .update(chatThreads)
        .set({
          previewSummary: null,
          previewSummaryUpdatedAt: null,
        })
        .where(eq(chatThreads.id, thread.id));
      return plan;
    });

    if (!editResult.ok) {
      if (editResult.error === "message_has_attachments") {
        return NextResponse.json(
          {
            error: "message_has_attachments",
            message:
              "Messages with uploaded files cannot be edited yet. Send a new follow-up instead.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: editResult.error },
        { status: editResult.error === "message_not_found" ? 404 : 409 },
      );
    }
    editedUserMessageId = editResult.targetId;
    // #456: message edits are destructive (they truncate the thread tail) —
    // audit the edit with what was removed, by reference.
    const editAuditNow = new Date();
    await db.insert(auditLog).values({
      actorUserId: sessionUser.id,
      actionType: "chat_message_edit",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "chat_message_edit",
      chatThreadId: thread.id,
      chatMessageId: editResult.targetId,
      input: { deletedMessageIds: editResult.deleteIds },
      startedAt: editAuditNow,
      completedAt: editAuditNow,
    });
    thread = {
      ...thread,
      previewSummary: null,
      previewSummaryUpdatedAt: null,
    };
  }

  const userMsg = editedUserMessageId
    ? [{ id: editedUserMessageId }]
    : await db
        .insert(chatMessages)
        .values({
          threadId: thread.id,
          role: "user",
          content: body.message,
        })
        .returning({ id: chatMessages.id });
  if (!editedUserMessageId) {
    // #456: user-content mutations audit like assistant ones (references
    // only; the content lives in chat_messages).
    const sendAuditNow = new Date();
    await db.insert(auditLog).values({
      actorUserId: sessionUser.id,
      actionType: "chat_message_create",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "chat_message_create",
      chatThreadId: thread.id,
      chatMessageId: userMsg[0]!.id,
      input: { role: "user" },
      startedAt: sendAuditNow,
      completedAt: sendAuditNow,
    });
  }

  // The bubble and model both receive the typed message. Queryable files ride
  // as compact resource references; only a resolver failure falls back to a
  // framed inline preview.
  // #416: the skill's operating instructions pin into the stable system
  // prefix (via the context pack's activeSkill input) instead of riding the
  // summarizable user message; only the user's own request stays here.
  const modelVisibleMessage = activatedSkill
    ? buildActivatedSkillUserMessage(activatedSkill.args)
    : effectiveUserMessage;
  const resourcePromptPlan = buildConversationResourcePrompt({
    message: modelVisibleMessage,
    attachments: effectiveAttachments,
    resourceIds: currentResourceIds,
    resolution: resourceResolution,
  });
  const promptForModel = resourcePromptPlan.prompt;
  const uploadedFiles = effectiveAttachments.map((a, index) => ({
    ...(currentResourceIds[index]
      ? { resourceId: currentResourceIds[index] }
      : {}),
    name: a.name,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    contentChars: a.content.length,
    extractionStatus: a.extractionStatus,
    ...(a.runtimeContent ? { runtimeContent: a.runtimeContent } : {}),
  }));
  const storedUploadedFiles = uploadedFiles.map((file) => ({
    ...(file.resourceId ? { resourceId: file.resourceId } : {}),
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    contentChars: file.contentChars,
    extractionStatus: file.extractionStatus,
  }));
  if (attachments.length > 0) {
    const secretFindings = scanAttachmentsForSecrets(attachments);
    await db.insert(workspaceArtifacts).values(
      pendingResources.map((pending, uploadIndex) => ({
        id: pending.id,
        userId: sessionUser.id,
        threadId: thread.id,
        chatMessageId: userMsg[0]!.id,
        title: pending.attachment.name,
        filename: pending.attachment.name,
        kind: pending.attachment.kind,
        mimeType: pending.attachment.mimeType,
        content: pending.attachment.storageContent,
        sizeBytes: pending.attachment.sizeBytes,
        source: "user-upload",
        metadata: {
          // Bulk insert shares one createdAt, so this ordinal is the ONLY
          // record of request order — replay (#348) sorts by it to keep
          // the re-folded prompt byte-identical to the original turn.
          uploadIndex,
          storageEncoding: pending.attachment.storageEncoding,
          extractionStatus: pending.attachment.extractionStatus,
          extractedText: pending.attachment.content,
          conversationResource: conversationResourceMetadata(pending),
          ...(pending.attachment.extractionNotes?.length
            ? { extractionNotes: pending.attachment.extractionNotes }
            : {}),
          ...(pending.attachment.image
            ? { image: pending.attachment.image }
            : {}),
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
      ...(activatedSkill ? { skillId: activatedSkill.skill.id } : {}),
      triggerType: "chat",
      status: runtimeRoute.useWorker ? "queued" : "running",
      modelId,
      inputs: {
        // Durable runs retain the user's instruction and resource references,
        // never a copy of uploaded file content.
        prompt: modelVisibleMessage,
        threadId: thread.id,
        userMessageId: userMsg[0]!.id,
        requestedByUserId: sessionUser.id,
        executionMode: runtimeRoute.executionMode,
        modelOverride,
        modelPreferenceSource: modelPreference.source,
        ...(modelCommand ? { modelCommand } : {}),
        runtimeRoute,
        uploadedFiles: storedUploadedFiles,
        resourceResolution,
        resourcePrompt: resourcePromptPlan.receipt,
        routeReceipt,
        // #432: preserved so a queued or retried execution of this turn uses
        // the same clock context the user sent it with.
        ...(userTimeZone ? { userTimeZone } : {}),
        ...(replaceMessageId ? { replaceMessageId } : {}),
        ...(activatedSkill
          ? {
              activatedSkills: [
                {
                  id: activatedSkill.skill.id,
                  slug: activatedSkill.skill.slug,
                  name: activatedSkill.skill.name,
                  source: "explicit",
                  args: activatedSkill.args,
                },
              ],
              requestedProviders: activatedSkill.skill.mcpProviders,
              activeSkillPrompt: {
                id: activatedSkill.skill.id,
                slug: activatedSkill.skill.slug,
                name: activatedSkill.skill.name,
                systemPrompt: activatedSkill.skill.systemPrompt,
              },
            }
          : {}),
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
        modelOverride,
        modelPreferenceSource: modelPreference.source,
        runtimeRoute,
        routeReceipt,
        resourceResolution,
        resourcePrompt: resourcePromptPlan.receipt,
        ...(replaceMessageId ? { replaceMessageId } : {}),
        ...(modelCommand ? { modelCommand } : {}),
        ...(activatedSkill
          ? {
              activatedSkills: [
                {
                  id: activatedSkill.skill.id,
                  slug: activatedSkill.skill.slug,
                  name: activatedSkill.skill.name,
                  source: "explicit",
                  args: activatedSkill.args,
                },
              ],
            }
          : {}),
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
        metadata: {
          uploadedFiles: storedUploadedFiles,
          resourceResolution,
          resourcePrompt: resourcePromptPlan.receipt,
        },
        occurredAt: queuedAt,
      });
    } else if (replayedAttachments) {
      // Replay receipt (#348). The bytes already live on the artifact rows,
      // so the event records names/sizes only — no runtimeContent copies.
      await appendRunEvent({
        db,
        runId: chatRunId,
        sequence: 2,
        eventType: "uploaded_files_replayed",
        status: "succeeded",
        label: `Replayed ${replayedAttachments.length} stored file${replayedAttachments.length === 1 ? "" : "s"} from the edited message`,
        metadata: {
          uploadedFiles: storedUploadedFiles,
          replayedArtifactIds,
          resourceResolution,
          resourcePrompt: resourcePromptPlan.receipt,
        },
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

  capturePostHogEvent({
    distinctId: sessionUser.id,
    event: "chat_turn_submitted",
    properties: {
      model_id: modelId,
      has_attachments: attachments.length > 0,
      is_edit: Boolean(replaceMessageId),
      has_activated_skill: Boolean(activatedSkill),
      runtime_lane: runtimeRoute.executionMode,
      uses_worker: runtimeRoute.useWorker,
    },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = createChatStreamWriter((event) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      });
      const send = writer.send;
      send({
        type: "meta",
        threadId: thread.id,
        runId: chatRunId,
        userMessageId: userMsg[0]!.id,
        modelId,
        modelOverride,
        executionMode: runtimeRoute.executionMode,
        runtimeRoute,
        routeReceipt,
        resourceResolution,
        ...(replaceMessageId ? { replaceMessageId } : {}),
      });
      if (runtimeRoute.useWorker) {
        send({
          type: "queued",
          threadId: thread.id,
          runId: chatRunId,
          status: "Queued for AgentCore worker",
        });
        send({ type: "done", stopReason: "queued" });
        controller.close();
        return;
      }

      let failureMessage =
        "Chat stream ended unexpectedly before a terminal event.";
      const stopHeartbeat = startChatStreamHeartbeat(send);
      try {
        await streamInlineChatRun({
          db,
          runId: chatRunId,
          thread,
          userId: sessionUser.id,
          userMessageId: userMsg[0]!.id,
          prompt: promptForModel,
          persistedPrompt: modelVisibleMessage,
          modelId,
          modelOverride,
          forceRequestedModel: modelPreference.source !== "request_default",
          route: runtimeRoute,
          requestStartedAt,
          uploadedFiles,
          resourceResolution,
          userTimeZone,
          activatedSkills: activatedSkill
            ? [
                {
                  id: activatedSkill.skill.id,
                  slug: activatedSkill.skill.slug,
                  name: activatedSkill.skill.name,
                  source: "explicit",
                  args: activatedSkill.args,
                },
              ]
            : undefined,
          requestedProviders: activatedSkill?.skill.mcpProviders,
          activeSkillPrompt: activatedSkill
            ? {
                id: activatedSkill.skill.id,
                slug: activatedSkill.skill.slug,
                name: activatedSkill.skill.name,
                systemPrompt: activatedSkill.skill.systemPrompt,
              }
            : undefined,
          signal: req.signal,
          send,
          diagnosticStreamEnabled: sessionUser.role === "admin",
        });
      } catch (err) {
        failureMessage = err instanceof Error ? err.message : String(err);
        if (!writer.hasTerminal()) {
          send({
            type: "error",
            message: failureMessage,
          });
        }
      } finally {
        stopHeartbeat();
        if (!writer.hasTerminal()) {
          send({
            type: "failed",
            stopReason: "stream_error",
            message: failureMessage,
          });
        }
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

function deriveThreadTitle(
  firstMessage: string,
  activatedSkill?: ActivatedSkillForChat | null,
): string {
  if (!activatedSkill) return deriveTitle(firstMessage);
  const args = activatedSkill.args.trim();
  return deriveTitle(
    args ? `${activatedSkill.skill.name}: ${args}` : activatedSkill.skill.name,
  );
}

function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.replace(/\s+/g, " ").trim();
  if (trimmed.length <= TITLE_MAX) return trimmed;
  return trimmed.slice(0, TITLE_MAX - 1) + "...";
}
