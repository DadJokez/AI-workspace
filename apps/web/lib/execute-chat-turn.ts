import {
  type ChatThread,
  auditLog,
  chatMessages,
  type Database,
  type Run,
  runs,
  users,
} from "@ai-workspace/db";
import { eq, ne, and, asc } from "drizzle-orm";
import type {
  AgentRuntime,
  RuntimeRunMetadata,
} from "@ai-workspace/agent-runtime";
import {
  extractAssistantSources,
  serializeActivation,
  type AssistantSource,
} from "@ai-workspace/agent";
import {
  buildChatContextPack,
  type ChatContextUploadedFile,
} from "@/lib/chat-context-pack";
import { loadUserCapabilityGraph } from "@/lib/capability-graph";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import type { ToolActionLevel } from "@/lib/tool-policy";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import type { ChatExecutionMode } from "@/lib/chat-execution-mode";
import { persistActivationFromEvent } from "@/lib/thread-activation";
import { buildTurnToolDiscovery } from "@/lib/tool-discovery";
import type { PinnedActiveSkill } from "@/lib/pinned-context";
import { resolveChatMcpProviderScope } from "@/lib/chat-mcp-provider-scope";
import {
  enqueueMemoryCapture,
  startInProcessMemoryCaptureScheduler,
} from "@/lib/memory-capture";
import {
  buildUserMcpServers,
  loadUserMcpProviderStatus,
  type McpWriteAuthorizationReceipt,
} from "@/lib/oauth/mcp-servers";
import {
  artifactContextTextForTurn,
  buildArtifactContextPayload,
  buildArtifactLookupMessage,
} from "@/lib/artifact-context";
import {
  resolveArtifactContextTargets,
  type WorkspaceArtifactVersionTarget,
} from "@/lib/artifact-revisions";
import type { AppDraftVersionSummary } from "@/lib/app-draft-versions";
import {
  buildAppEditContext,
  createDraftAppVersionsForThreadArtifacts,
} from "@/lib/apps";
import { shouldPersistAssistantMessage } from "@/lib/assistant-persistence";
import { persistAssistantMessageOnce } from "@/lib/assistant-message-persistence";
import {
  appendRunEventBestEffort,
  appendToolCallRunEvent,
  appendToolResultRunEvent,
  type AppendRunEventInput,
} from "@/lib/run-events";
import {
  normalizeRuntimeError,
  type NormalizedRuntimeError,
} from "@/lib/runtime-errors";
import type { RuntimeModelSelection } from "@/lib/runtime-model-policy";
import { createToolEventAccumulator } from "@/lib/tool-events";
import { refreshThreadPresentationMetadata } from "@/lib/thread-metadata";
import { buildTurnContext } from "@/lib/turn-context";
import type { RecentToolEvidenceReceipt } from "@/lib/recent-tool-evidence";
import { attachUploadedFilesToLatestUserMessage } from "@/lib/runtime-attachments";
import { builtinToolsForChatRoute } from "@/lib/runtime-builtin-tools";
import { normalizeRuntimeUsage } from "@/lib/runtime-usage";
import {
  createProviderTraceAccumulator,
  persistProviderTraceCapture,
} from "@/lib/run-trace";
import { loadApprovedVaultMarkdown } from "@/lib/vault-memory";
import {
  createArtifactsFromAssistantMessage,
  type WorkspaceArtifactSummary,
} from "@/lib/workspace-artifacts";
import {
  createRecommendationsForAssistantMessage,
  loadRecentRecommendationsForThread,
} from "@/lib/recommendation-persistence";
import type { PersistedRecommendation } from "@/lib/recommendations";
import { createProactiveRunNotification } from "@/lib/notifications";
import {
  revalidateConversationResourceResolution,
  type ConversationResourceResolution,
} from "@/lib/conversation-resources";
import {
  buildConversationResourceMcpServer,
  CONVERSATION_RESOURCE_PROVIDER,
  CONVERSATION_RESOURCE_QUERY_TOOL,
  loadSelectedResourceImages,
} from "@/lib/conversation-resource-runtime";
import type {
  ChatRunTimingMetrics,
  ChatStreamSend,
} from "@/lib/chat-stream-contract";

/**
 * #442 — the single chat-turn pipeline. Both execution lanes (interactive
 * SSE and background worker) run the same 13 steps here: provider scope →
 * loads → artifact/app contexts → turn context → MCP mount → tool discovery
 * → attestation audit → context pack → run bookkeeping → runTurn event loop
 * → trace persist → persist tail. Lane-specific behavior (SSE + timing vs
 * lease/heartbeat + notification) is carried by `ChatTurnLane` and branched
 * explicitly, so a future turn feature is written once and every lane
 * divergence is a visible, reviewable decision instead of a hand-sync.
 */

export type ChatTurnTerminalStatus = "succeeded" | "failed";

export interface ChatRunTimingMarks {
  requestStartedAt: Date;
  inlineStartedAt: Date;
  contextReadyAt?: Date;
  providerStartedAt?: Date;
  firstTokenAt?: Date;
  completedAt?: Date;
}

export type ChatTurnLane =
  | {
      kind: "inline";
      send: ChatStreamSend;
      /** The browser request signal; disconnect ends the turn. */
      signal?: AbortSignal;
      diagnosticStreamEnabled: boolean;
      timing: ChatRunTimingMarks;
      modelSelection: RuntimeModelSelection;
      requestedModelId: string;
      modelOverride: boolean;
      activatedSkills?: Array<Record<string, unknown>>;
    }
  | {
      kind: "worker";
      /** Claim-time snapshot; prior outputs seed resume + terminal merge. */
      run: Run;
      /** Lease owner id; terminal writes are fenced on it (#443). */
      workerId: string;
      /** Parsed run inputs, re-persisted with mount metadata folded in. */
      storedInputs: Record<string, unknown>;
      executionMode: ChatExecutionMode;
      timeoutMs: number;
      preferArtifactFallback: boolean;
      storedArtifactTarget: WorkspaceArtifactVersionTarget | null;
      storedSeparateFromArtifact: WorkspaceArtifactVersionTarget | null;
    };

export interface ExecuteChatTurnInput {
  db: Database;
  runId: string;
  userId: string;
  thread: ChatThread;
  prompt: string;
  /** Clean user instruction; `prompt` may carry current-turn attachment data. */
  persistedPrompt?: string;
  userMessageId: string;
  route: ChatRuntimeRoute;
  runtime: AgentRuntime;
  /** Aborted by the lane shell (browser disconnect, worker timeout/SIGTERM). */
  runtimeAbort: AbortController;
  /** Turn-time validated model id (#300) — both lanes resolve before calling. */
  modelId: string;
  requestedProviders?: string[];
  activeSkillPrompt?: PinnedActiveSkill | null;
  uploadedFiles?: ChatContextUploadedFile[];
  resourceResolution?: ConversationResourceResolution;
  /**
   * Validated IANA timezone of the user's browser (#432). Interactive chat
   * turns carry it (the worker lane re-validates it out of stored inputs);
   * scheduled/background triggers leave it unset so their clock stays
   * UTC-only.
   */
  userTimeZone?: string;
  suppressedSkillIds?: string[];
  /** Interactive turns unlock write-authorization prompts in the MCP mount. */
  interactive: boolean;
  lane: ChatTurnLane;
}

export async function executeChatTurn({
  db,
  runId,
  userId,
  thread,
  prompt,
  persistedPrompt,
  userMessageId,
  route,
  runtime,
  runtimeAbort,
  modelId,
  requestedProviders,
  activeSkillPrompt,
  uploadedFiles = [],
  resourceResolution,
  userTimeZone,
  suppressedSkillIds = [],
  interactive,
  lane,
}: ExecuteChatTurnInput): Promise<void> {
  const userInstruction = persistedPrompt ?? prompt;
  const timing = lane.kind === "inline" ? lane.timing : undefined;
  const priorOutputs =
    lane.kind === "worker" ? parseStoredOutputs(lane.run.outputs) : {};
  const builtinTools = builtinToolsForChatRoute(route);
  const mcpProviderScope = resolveChatMcpProviderScope(
    requestedProviders,
    route.routingMode,
  );
  // The worker lane has always mounted Vault context regardless of the
  // stored route; the interactive lane follows the route.
  const includeVaultContext =
    lane.kind === "worker" || route.includeVaultContext;

  const [userRows, history, vaultMarkdown, providerStatus, recentRecommendations] =
    await Promise.all([
      db
        .select({
          displayName: users.displayName,
          assistantName: users.assistantName,
          customInstructions: users.customInstructions,
          role: users.role,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.threadId, thread.id))
        .orderBy(asc(chatMessages.createdAt)),
      includeVaultContext
        ? loadApprovedVaultMarkdown(db, userId)
        : Promise.resolve(null),
      loadUserMcpProviderStatus(
        db,
        userId,
        mcpProviderScope.accountStatusOptions,
      ),
      loadRecentRecommendationsForThread({
        db,
        userId,
        threadId: thread.id,
      }),
    ]);
  const effectiveResourceResolution = resourceResolution
    ? await revalidateConversationResourceResolution({
        db,
        userId,
        threadId: thread.id,
        resolution: resourceResolution,
      })
    : undefined;

  // Match artifacts against recent RAW user messages, not the
  // attachment-folded prompt — so uploaded file bytes can't pull in an
  // unrelated artifact, while "it/that one" follow-ups still have context.
  const [artifactContextPayload, appEditContextResult] = await Promise.all([
    buildArtifactContextPayload({
      db,
      userId,
      threadId: thread.id,
      message:
        lane.kind === "worker"
          ? buildArtifactLookupMessage(history, userInstruction, {
              preferFallback: lane.preferArtifactFallback,
            })
          : buildArtifactLookupMessage(history, userInstruction),
    }),
    buildAppEditContext({ db, userId, threadId: thread.id }),
  ]);
  const { artifactContextTarget, separateFromArtifact } =
    resolveArtifactContextTargets(
      lane.kind === "worker"
        ? {
            payload: artifactContextPayload,
            storedArtifactTarget: lane.storedArtifactTarget,
            storedSeparateFromArtifact: lane.storedSeparateFromArtifact,
          }
        : { payload: artifactContextPayload },
    );
  const artifactContext = artifactContextTextForTurn({
    payload: artifactContextPayload,
    uploadedFiles,
  });
  const appEditContext = appEditContextResult?.context ?? null;
  const appEditSourceOmitted =
    appEditContextResult?.contentOmittedForSize ?? false;
  const combinedArtifactContext = [appEditContext, artifactContext]
    .filter(Boolean)
    .join("\n\n");

  const user = userRows[0] ?? {
    displayName: "User",
    assistantName: null,
    customInstructions: null,
    role: "user" as const,
  };
  let recentToolEvidenceReceipt: RecentToolEvidenceReceipt | undefined;
  const selectedResourceImages = effectiveResourceResolution
    ? await loadSelectedResourceImages({
        db,
        userId,
        threadId: thread.id,
        resolution: effectiveResourceResolution,
      })
    : [];
  const runtimeUploadedFiles = dedupeUploadedFiles([
    ...uploadedFiles,
    ...selectedResourceImages,
  ]);
  const agentMessages = attachUploadedFilesToLatestUserMessage(
    buildTurnContext({
      messages: history,
      currentMessageContent: prompt,
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
      onToolEvidenceReceipt: (receipt) => {
        recentToolEvidenceReceipt = receipt;
      },
    }),
    runtimeUploadedFiles,
  );

  let mcpServers;
  let requiredToolName: string | undefined;
  let deniedMcpProviders: string[] = [];
  let writeAuthorizationReceipts: McpWriteAuthorizationReceipt[] = [];
  if (lane.kind === "worker" || route.useMcp) {
    try {
      const mcpAccess = await buildUserMcpServers(db, userId, {
        ...mcpProviderScope.mountOptions,
        turnContext: {
          runId,
          threadId: thread.id,
          prompt: userInstruction,
          history,
          interactive,
        },
      });
      mcpServers = mcpAccess.mcpServers;
      requiredToolName = mcpAccess.requiredToolName;
      deniedMcpProviders = mcpAccess.deniedProviders;
      writeAuthorizationReceipts = mcpAccess.writeAuthorizationReceipts;
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
  const accountMcpProviders = mcpServers ? Object.keys(mcpServers) : [];
  if (effectiveResourceResolution?.status === "selected") {
    try {
      const resourceServer = buildConversationResourceMcpServer({
        userId,
        threadId: thread.id,
        runId,
        resolution: effectiveResourceResolution,
      });
      if (resourceServer) {
        mcpServers = {
          ...(mcpServers ?? {}),
          [CONVERSATION_RESOURCE_PROVIDER]: resourceServer,
        };
        if (
          effectiveResourceResolution.requiresCompleteFileTool &&
          !requiredToolName
        ) {
          requiredToolName = CONVERSATION_RESOURCE_QUERY_TOOL;
        }
      }
    } catch (err) {
      process.stderr.write(
        `[conversation-resource-mcp-build-error] ${JSON.stringify({
          runId,
          threadId: thread.id,
          resourceIds: effectiveResourceResolution.selected.map(
            (resource) => resource.resourceId,
          ),
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  }

  const mountedProviders = mcpServers ? Object.keys(mcpServers) : [];
  // #384: sticky per-thread activation, resolved BEFORE the context pack
  // so the preamble/receipt tell the truth about what this turn mounts.
  // Conversations start at the core bundle + discovery tools; providers
  // activate stickily via comparative__activate_tools.
  const baseToolDiscovery =
    mountedProviders.length > 0
      ? await buildTurnToolDiscovery({
          db,
          thread,
          grantedProviders: accountMcpProviders,
          userMessage: userInstruction,
          skillProviders: requestedProviders,
        })
      : undefined;
  const toolDiscovery = baseToolDiscovery
    ? {
        ...baseToolDiscovery,
        activatedProviders: uniqueStrings([
          ...baseToolDiscovery.activatedProviders,
          ...(mountedProviders.includes(CONVERSATION_RESOURCE_PROVIDER)
            ? [CONVERSATION_RESOURCE_PROVIDER]
            : []),
        ]),
      }
    : undefined;
  const discoverableProviders = toolDiscovery?.discoverableProviders ?? [];
  const blockedProviders = uniqueStrings([
    ...providerStatus.deniedProviders,
    ...deniedMcpProviders,
  ]);
  const capabilityGraph = await loadUserCapabilityGraph(
    db,
    { id: userId, role: user.role },
    { mountedProviders },
  );

  // Denied-provider attestation audit — in the shared core so BOTH lanes
  // write it by construction (#442: the interactive lane used to skip it,
  // under-reporting denied access on the dominant lane).
  if (blockedProviders.length > 0) {
    await db.insert(auditLog).values(
      blockedProviders.map((provider) => ({
        actorUserId: userId,
        actionType: "mcp_tool_attestation",
        status: "denied" as const,
        provider,
        toolName: "*",
        chatThreadId: thread.id,
        runId,
        input: { provider },
        error: `Tool provider "${provider}" is connected but has no active user attestation.`,
        metadata: { modelId, runtime: runtime.name },
        startedAt: new Date(),
        completedAt: new Date(),
      })),
    );
  }

  const contextPack = buildChatContextPack({
    user,
    messages: agentMessages,
    vaultMarkdown,
    vaultContextRequested: includeVaultContext,
    providerStatus,
    mountedProviders: toolDiscovery
      ? toolDiscovery.activatedProviders
      : mountedProviders,
    discoverableProviders,
    deniedMcpProviders,
    capabilityGraph,
    modelId,
    artifactContext: combinedArtifactContext,
    uploadedFiles: runtimeUploadedFiles,
    recentToolEvidenceReceipt,
    resourceResolution: effectiveResourceResolution,
    recommendations: recentRecommendations,
    route,
    builtinTools,
    ...(lane.kind === "worker" ? { forcePreamble: true } : {}),
    activeSkill: activeSkillPrompt ?? null,
  });
  const contextReceipt = contextPack.receipts[0]!;
  if (timing) timing.contextReadyAt = new Date();

  const mountInputs = {
    mcpProviders: mountedProviders,
    uploadedFiles: runtimeUploadedFiles.map((file) => ({
      ...(file.resourceId ? { resourceId: file.resourceId } : {}),
      name: file.name,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      ...(file.contentChars !== undefined
        ? { contentChars: file.contentChars }
        : {}),
      ...(file.extractionStatus
        ? { extractionStatus: file.extractionStatus }
        : {}),
    })),
    ...(requiredToolName ? { requiredToolName } : {}),
    writeAuthorizationReceipts,
    ...(effectiveResourceResolution
      ? { resourceResolution: effectiveResourceResolution }
      : {}),
    accountConnectedMcpProviders: providerStatus.connectedProviders,
    approvedMcpProviders: providerStatus.allowedProviders,
    deniedMcpProviders: blockedProviders,
    contextReceipt,
    ...(artifactContextTarget ? { artifactContextTarget } : {}),
    ...(separateFromArtifact ? { separateFromArtifact } : {}),
  };
  await db
    .update(runs)
    .set({
      modelId,
      runtime: runtime.name,
      inputs:
        lane.kind === "inline"
          ? {
              prompt: userInstruction,
              threadId: thread.id,
              userMessageId,
              requestedByUserId: userId,
              requestedModelId: lane.requestedModelId,
              modelOverride: lane.modelOverride,
              runtimeModelId: modelId,
              providerModelId: lane.modelSelection.providerModelId,
              modelSelection: lane.modelSelection,
              runtimeTarget: route.runtimeTarget,
              executionMode: route.executionMode,
              runtimeRoute: route,
              ...(lane.activatedSkills
                ? { activatedSkills: lane.activatedSkills }
                : {}),
              ...(requestedProviders ? { requestedProviders } : {}),
              // #432: keep the turn's clock context on the run row so a
              // queued or retried execution resolves dates the same way.
              ...(userTimeZone ? { userTimeZone } : {}),
              ...mountInputs,
              metrics: buildTimingMetrics(lane.timing),
            }
          : { ...lane.storedInputs, ...mountInputs },
      updatedAt: new Date(),
    })
    .where(eq(runs.id, runId));

  await appendTurnRunEvent(lane, {
    db,
    runId,
    eventType: "context_pack_assembled",
    status: "succeeded",
    label: "Assembled context pack",
    metadata: { contextReceipt, writeAuthorizationReceipts },
  });

  if (lane.kind === "inline") {
    await appendTurnRunEvent(lane, {
      db,
      runId,
      eventType: "inline_runtime_started",
      status: "pending",
      label:
        route.lane === "tool-local"
          ? "Started local streaming run with tools"
          : "Started local streaming run",
      metadata: {
        lane: route.lane,
        runtimeTarget: route.runtimeTarget,
        runtime: runtime.name,
        requestedModelId: lane.requestedModelId,
        modelOverride: lane.modelOverride,
        runtimeModelId: modelId,
        providerModelId: lane.modelSelection.providerModelId,
        modelSelection: lane.modelSelection,
        reasons: route.reasons,
        mcpProviders: mountedProviders,
        ...(requiredToolName ? { requiredToolName } : {}),
        writeAuthorizationReceipts,
        accountConnectedMcpProviders: providerStatus.connectedProviders,
        approvedMcpProviders: providerStatus.allowedProviders,
        deniedMcpProviders: blockedProviders,
        contextReceipt,
        metrics: buildTimingMetrics(lane.timing),
      },
    });
    lane.send({
      type: "model",
      requestedModelId: lane.requestedModelId,
      modelOverride: lane.modelOverride,
      modelId,
      providerModelId: lane.modelSelection.providerModelId,
      modelSelection: lane.modelSelection,
      runtime: runtime.name,
      runtimeTarget: route.runtimeTarget,
    });
  } else {
    await appendTurnRunEvent(lane, {
      db,
      runId,
      eventType: "worker_started",
      status: "pending",
      label: "Background worker started the agent run",
      metadata: {
        runtime: runtime.name,
        modelId,
        executionMode: lane.executionMode,
      },
    });
  }

  let assistantText = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let inputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let providerRunMetadata: RuntimeRunMetadata | null =
    lane.kind === "worker" ? (priorOutputs.providerRun ?? null) : null;
  const runtimeErrors: NormalizedRuntimeError[] = [];
  const toolEvents = createToolEventAccumulator(mountedProviders);
  const providerTrace = createProviderTraceAccumulator();
  const errorContext = {
    runtime: runtime.name,
    runtimeTarget: route.runtimeTarget,
    requestedModelId:
      lane.kind === "inline" ? lane.modelSelection.requestedModelId : modelId,
    modelId,
    ...(lane.kind === "inline" && lane.modelSelection.providerModelId
      ? { providerModelId: lane.modelSelection.providerModelId }
      : {}),
  };
  const buildWorkerOutput = (extra: Record<string, unknown> = {}) => ({
    ...priorOutputs,
    assistantText,
    toolCalls: toolEvents.calls(),
    toolResults: toolEvents.results(),
    tokensIn,
    tokensOut,
    usage: {
      tokensIn,
      tokensOut,
      inputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
    },
    modelId,
    runtime: runtime.name,
    ...(providerRunMetadata ? { providerRun: providerRunMetadata } : {}),
    ...extra,
  });

  // #452: the worker lane used to SELECT the run row once per streamed
  // event — including every text-delta. Throttled to a cheap cadence; the
  // post-stream isRunCanceled checks keep the terminal semantics exact.
  const workerCanceled = throttleCancellationCheck(() =>
    isRunCanceled(db, runId),
  );
  let providerTerminalSeen = false;
  let providerStreamTruncated = false;

  try {
    // Tracks persisted activation across same-turn activations so a
    // second activate never unions against a stale snapshot.
    const grantedProviders = accountMcpProviders;
    let activationSignature = serializeActivation(
      toolDiscovery?.activatedProviders ?? [],
    );

    for await (const ev of runtime.runTurn({
      threadId: thread.id,
      modelId,
      messages: contextPack.prompt.messages,
      context: { userId },
      signal: runtimeAbort.signal,
      volatileSystemSuffix: contextPack.prompt.volatileSystemSuffix,
      ...(userTimeZone ? { userTimeZone } : {}),
      // Same content, different composition slot: the AgentCore container
      // composes [systemPrompt, firstTurnPreamble] itself, and the durable
      // lane has always ridden the preamble slot. Keyed by lane to preserve
      // each lane's historical prompt assembly byte-for-byte.
      ...(lane.kind === "inline"
        ? { systemPrompt: contextPack.prompt.systemPrompt }
        : { firstTurnPreamble: contextPack.prompt.systemPrompt }),
      onRunStarted: async (metadata) => {
        providerRunMetadata = metadata;
        if (lane.kind === "inline") {
          lane.timing.providerStartedAt = new Date();
          const metrics = buildTimingMetrics(lane.timing);
          lane.send({ type: "metrics", stage: "provider_started", metrics });
          await db
            .update(runs)
            .set({
              outputs: {
                assistantText,
                lifecycle: "provider_started",
                requestedModelId: lane.requestedModelId,
                modelId,
                providerModelId: lane.modelSelection.providerModelId,
                modelSelection: lane.modelSelection,
                runtime: runtime.name,
                runtimeTarget: route.runtimeTarget,
                providerRun: metadata,
                metrics,
              },
              updatedAt: new Date(),
            })
            .where(eq(runs.id, runId));
          await appendTurnRunEvent(lane, {
            db,
            runId,
            eventType: "provider_run_started",
            status: "pending",
            label: `Started ${runtime.name} run`,
            metadata: {
              ...(metadata as unknown as Record<string, unknown>),
              runtimeTarget: route.runtimeTarget,
              requestedModelId: lane.requestedModelId,
              runtimeModelId: modelId,
              providerModelId: lane.modelSelection.providerModelId,
              modelSelection: lane.modelSelection,
              metrics,
            },
          });
        } else {
          await db
            .update(runs)
            .set({
              outputs: buildWorkerOutput({
                lifecycle: "provider_started",
                providerRun: metadata,
              }),
              updatedAt: new Date(),
            })
            .where(eq(runs.id, runId));
          await appendTurnRunEvent(lane, {
            db,
            runId,
            eventType: "provider_run_started",
            status: "pending",
            label: `Started ${runtime.name} run`,
            metadata: metadata as unknown as Record<string, unknown>,
          });
        }
      },
      ...(mcpServers ? { mcpServers } : {}),
      ...(builtinTools.length > 0 ? { builtinTools } : {}),
      ...(requiredToolName ? { requiredToolName } : {}),
      ...(toolDiscovery ? { toolDiscovery } : {}),
    })) {
      if (providerTerminalSeen) {
        throw new Error(
          `Chat runtime emitted ${ev.type} after its done event.`,
        );
      }
      providerTrace.record(ev);
      if (ev.type === "done") {
        providerTerminalSeen = true;
        continue;
      }
      // Sticky activation persistence (#384 P2) — the shared trigger for
      // both runtime lanes; see persistActivationFromEvent.
      if (toolDiscovery) {
        activationSignature = await persistActivationFromEvent({
          db,
          threadId: thread.id,
          grantedProviders,
          event: ev,
          currentSignature: activationSignature,
        });
      }
      const canceled =
        lane.kind === "inline"
          ? (lane.signal?.aborted ?? false)
          : await workerCanceled();
      if (canceled) {
        runtimeAbort.abort();
        break;
      }
      if (ev.type === "text-delta") {
        assistantText += ev.delta;
        if (lane.kind === "inline") {
          lane.send({ type: "text-delta", delta: ev.delta });
          if (!lane.timing.firstTokenAt && ev.delta.length > 0) {
            lane.timing.firstTokenAt = new Date();
            const metrics = buildTimingMetrics(lane.timing);
            lane.send({ type: "metrics", stage: "first_token", metrics });
            await appendTurnRunEvent(lane, {
              db,
              runId,
              eventType: "first_token_streamed",
              status: "succeeded",
              label: "First token streamed",
              metadata: {
                runtimeTarget: route.runtimeTarget,
                runtime: runtime.name,
                requestedModelId: lane.requestedModelId,
                runtimeModelId: modelId,
                providerModelId: lane.modelSelection.providerModelId,
                modelSelection: lane.modelSelection,
                metrics,
              },
            });
          }
        }
      } else if (ev.type === "provider-reasoning-delta") {
        if (lane.kind === "inline" && lane.diagnosticStreamEnabled) {
          lane.send({
            type: ev.type,
            iteration: ev.iteration,
            blockIndex: ev.blockIndex,
            delta: ev.delta,
          });
        }
      } else if (ev.type === "provider-reasoning-redacted") {
        if (lane.kind === "inline" && lane.diagnosticStreamEnabled) {
          lane.send({
            type: ev.type,
            iteration: ev.iteration,
            blockIndex: ev.blockIndex,
          });
        }
      } else if (ev.type === "provider-response-metadata") {
        if (lane.kind === "inline" && lane.diagnosticStreamEnabled) {
          lane.send({ ...ev });
        }
      } else if (ev.type === "usage") {
        const usage = normalizeRuntimeUsage(ev);
        tokensIn = usage.tokensIn;
        tokensOut = usage.tokensOut;
        inputTokens = usage.inputTokens;
        cacheReadInputTokens = usage.cacheReadInputTokens;
        cacheWriteInputTokens = usage.cacheWriteInputTokens;
        if (lane.kind === "inline") {
          // #359: live token counts for the run footer — totals only, the
          // full breakdown ships with `persisted` as before.
          lane.send({ type: "usage", tokensIn, tokensOut });
        }
      } else if (ev.type === "tool-call") {
        toolEvents.recordCall(ev.call);
        const persistedCall = toolEvents
          .calls()
          .find((call) => call.id === ev.call.id);
        if (!persistedCall) {
          throw new Error(`Failed to normalize tool call ${ev.call.id}.`);
        }
        await appendToolCallRunEvent({
          db,
          runId,
          call: persistedCall,
        });
        if (lane.kind === "inline") {
          // #359: stream the REDACTED copy — the live SSE previously sent
          // the raw runtime payload while only the persisted copy was
          // redacted, so a viewer's live stream could carry what replay
          // would have scrubbed.
          lane.send({ type: "tool-call", call: persistedCall });
        }
      } else if (ev.type === "tool-result") {
        toolEvents.recordResult(ev.result);
        const persistedResult = toolEvents
          .results()
          .find((result) => result.toolCallId === ev.result.toolCallId);
        if (!persistedResult) {
          throw new Error(
            `Failed to normalize tool result ${ev.result.toolCallId}.`,
          );
        }
        const persistedCall = toolEvents
          .calls()
          .find((call) => call.id === ev.result.toolCallId);
        await appendToolResultRunEvent({
          db,
          runId,
          call: persistedCall,
          result: persistedResult,
        });
        if (lane.kind === "inline") {
          // #359: redacted copy on the live stream too (see tool-call above).
          lane.send({
            type: "tool-result",
            result: persistedResult,
          });
        }
      } else if (ev.type === "error") {
        const normalized = normalizeRuntimeError(ev.message, errorContext);
        runtimeErrors.push(normalized);
        if (lane.kind === "inline") {
          lane.send({ type: "error", message: normalized.userMessage });
        } else {
          process.stderr.write(
            `[chat-run-worker-runtime-error] ${JSON.stringify({
              runId,
              threadId: thread.id,
              message: ev.message,
            })}\n`,
          );
        }
      }
    }
  } catch (err) {
    if (lane.kind === "worker") {
      if (await isRunCanceled(db, runId)) {
        runtimeAbort.abort();
      } else {
        await persistProviderTraceCapture({
          db,
          runId,
          capture: providerTrace.snapshot(),
        });
        // The worker shell marks the run failed and notifies.
        throw err;
      }
    } else {
      const normalized = normalizeRuntimeError(err, errorContext);
      runtimeErrors.push(normalized);
      lane.send({ type: "error", message: normalized.userMessage });
      await appendTurnRunEvent(lane, {
        db,
        runId,
        eventType: "provider_run_failed",
        status: "failed",
        label: "Provider run failed",
        error: normalized.userMessage,
        metadata: {
          errorDetails: normalized,
          runtimeTarget: route.runtimeTarget,
          runtime: runtime.name,
          requestedModelId: lane.requestedModelId,
          runtimeModelId: modelId,
          providerModelId: lane.modelSelection.providerModelId,
          modelSelection: lane.modelSelection,
          metrics: buildTimingMetrics(lane.timing),
        },
      });
    }
  }

  if (
    !providerTerminalSeen &&
    !runtimeAbort.signal.aborted &&
    runtimeErrors.length === 0
  ) {
    providerStreamTruncated = true;
    const normalized = normalizeRuntimeError(
      "The model response ended before its completion event. Please try again.",
      errorContext,
    );
    runtimeErrors.push(normalized);
    if (lane.kind === "inline") {
      lane.send({ type: "error", message: normalized.userMessage });
      await appendTurnRunEvent(lane, {
        db,
        runId,
        eventType: "provider_run_failed",
        status: "failed",
        label: "Provider stream ended before completion",
        error: normalized.userMessage,
        metadata: {
          errorDetails: normalized,
          runtimeTarget: route.runtimeTarget,
          runtime: runtime.name,
          requestedModelId: lane.requestedModelId,
          runtimeModelId: modelId,
          providerModelId: lane.modelSelection.providerModelId,
          modelSelection: lane.modelSelection,
          metrics: buildTimingMetrics(lane.timing),
        },
      });
    } else {
      process.stderr.write(
        `[chat-run-worker-runtime-error] ${JSON.stringify({
          runId,
          threadId: thread.id,
          message: normalized.rawMessage,
        })}\n`,
      );
    }
  }

  if (lane.kind === "worker" && (await isRunCanceled(db, runId))) {
    await persistProviderTraceCapture({
      db,
      runId,
      capture: providerTrace.snapshot(),
    });
    await appendTurnRunEvent(lane, {
      db,
      runId,
      eventType: "worker_stopped_after_cancel",
      status: "failed",
      label: "Worker stopped after cancellation",
    });
    return;
  }

  const abortError =
    lane.kind === "inline"
      ? lane.signal?.aborted
        ? "Browser request disconnected before the local chat run completed."
        : null
      : runtimeAbort.signal.aborted
        ? `Chat runtime timed out after ${lane.timeoutMs}ms.`
        : null;
  const runError =
    abortError ??
    (runtimeErrors.length > 0
      ? runtimeErrors.map((err) => err.userMessage).join("\n")
      : null);
  const completedAt = new Date();
  if (timing) timing.completedAt = completedAt;
  const finalMetrics = timing ? buildTimingMetrics(timing) : undefined;
  await persistProviderTraceCapture({
    db,
    runId,
    capture: providerTrace.snapshot(completedAt),
  });

  const persisted = await persistChatTurnResult({
    db,
    runId,
    userId,
    threadId: thread.id,
    userMessageId,
    modelId,
    runtimeName: runtime.name,
    runtimeTarget: route.runtimeTarget,
    toolActions: providerStatus.toolActions,
    assistantText,
    tokensIn,
    tokensOut,
    inputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    toolCalls: toolEvents.calls(),
    toolResults: toolEvents.results(),
    providerRunMetadata,
    runtimeErrors,
    terminalStatus: runError ? "failed" : "succeeded",
    error: runError,
    timingMetrics: finalMetrics,
    suppressedSkillIds,
    artifactContextTarget,
    separateFromArtifact,
    appEditSourceOmitted,
    suppressAssistantPersistence: providerStreamTruncated,
    completedAt,
    priorOutputs,
    lane,
  });

  if (lane.kind === "inline") {
    lane.send({ type: "metrics", stage: "completed", metrics: finalMetrics });
    if (runError) {
      lane.send({
        type: "failed",
        stopReason: abortError ? "request_aborted" : "runtime_error",
        message: runError,
      });
      return;
    }
    lane.send({
      type: "persisted",
      assistantMessageId: persisted.assistantMessageId,
      tokensIn,
      tokensOut,
      artifacts: persisted.artifacts,
      appDraftVersions: persisted.appDraftVersions,
      recommendations: persisted.recommendations,
      sources: persisted.sources,
      runId,
      threadId: thread.id,
    });
    lane.send({ type: "done", stopReason: "completed" });
  }
}

async function persistChatTurnResult({
  db,
  runId,
  userId,
  threadId,
  userMessageId,
  modelId,
  runtimeName,
  runtimeTarget,
  toolActions,
  assistantText,
  tokensIn,
  tokensOut,
  inputTokens,
  cacheReadInputTokens,
  cacheWriteInputTokens,
  toolCalls,
  toolResults,
  providerRunMetadata,
  runtimeErrors,
  terminalStatus,
  error,
  timingMetrics,
  suppressedSkillIds,
  artifactContextTarget,
  separateFromArtifact,
  appEditSourceOmitted,
  suppressAssistantPersistence,
  completedAt,
  priorOutputs,
  lane,
}: {
  db: Database;
  runId: string;
  userId: string;
  threadId: string;
  userMessageId: string;
  modelId: string;
  runtimeName: string;
  runtimeTarget: ChatRuntimeRoute["runtimeTarget"];
  toolActions?: Record<string, ToolActionLevel>;
  assistantText: string;
  tokensIn: number;
  tokensOut: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  toolCalls: ReturnType<ReturnType<typeof createToolEventAccumulator>["calls"]>;
  toolResults: ReturnType<
    ReturnType<typeof createToolEventAccumulator>["results"]
  >;
  providerRunMetadata: RuntimeRunMetadata | null;
  runtimeErrors: NormalizedRuntimeError[];
  terminalStatus: ChatTurnTerminalStatus;
  error: string | null;
  timingMetrics?: ChatRunTimingMetrics;
  suppressedSkillIds: string[];
  artifactContextTarget?: WorkspaceArtifactVersionTarget | null;
  separateFromArtifact?: WorkspaceArtifactVersionTarget | null;
  appEditSourceOmitted: boolean;
  suppressAssistantPersistence: boolean;
  completedAt: Date;
  priorOutputs: StoredChatRunOutputs;
  lane: ChatTurnLane;
}): Promise<{
  assistantMessageId: string | undefined;
  artifacts: WorkspaceArtifactSummary[];
  appDraftVersions: AppDraftVersionSummary[];
  recommendations: PersistedRecommendation[];
  sources: AssistantSource[];
}> {
  const empty = {
    assistantMessageId: undefined,
    artifacts: [],
    appDraftVersions: [],
    recommendations: [],
    sources: [],
  };
  if (lane.kind === "worker" && (await isRunCanceled(db, runId))) return empty;

  // Worker resume reuses a message persisted by an earlier attempt.
  let assistantMessageId =
    lane.kind === "worker" ? priorOutputs.assistantMessageId : undefined;
  let artifacts: WorkspaceArtifactSummary[] = [];
  let appDraftVersions: AppDraftVersionSummary[] = [];
  let recommendations: PersistedRecommendation[] = [];
  const sources =
    terminalStatus === "succeeded"
      ? extractAssistantSources({ toolCalls, toolResults })
      : [];
  const shouldPersistAssistant =
    !suppressAssistantPersistence &&
    shouldPersistAssistantMessage({
      terminalStatus,
      assistantText,
      toolCallsCount: toolCalls.length,
      toolResultsCount: toolResults.length,
    });

  if (!assistantMessageId && shouldPersistAssistant) {
    const persisted = await persistAssistantMessageOnce({
      db,
      runId,
      userId,
      threadId,
      lane: lane.kind,
      ...(lane.kind === "worker"
        ? { expectedWorkerId: lane.workerId }
        : {}),
      content: assistantText,
      modelId,
      runtime: runtimeName,
      tokensIn,
      tokensOut,
      toolCalls,
      toolResults,
    });
    assistantMessageId = persisted?.assistantMessageId;
  }

  if (assistantMessageId) {
    const toolAuditRows = buildToolAuditRows({
      actorUserId: userId,
      chatThreadId: threadId,
      chatMessageId: assistantMessageId,
      runId,
      modelId,
      runtime: runtimeName,
      calls: toolCalls,
      results: toolResults,
      toolActions,
    });
    if (toolAuditRows.length > 0) {
      await db.insert(auditLog).values(toolAuditRows);
    }
  }

  if (terminalStatus === "succeeded" && assistantMessageId) {
    try {
      artifacts = await createArtifactsFromAssistantMessage({
        db,
        userId,
        threadId,
        chatMessageId: assistantMessageId,
        runId,
        assistantText,
        targetArtifact: artifactContextTarget,
        separateFromArtifact,
        turnToolCalls: toolCalls,
        turnToolResults: toolResults,
      });
      if (artifacts.length > 0) {
        await appendTurnRunEvent(lane, {
          db,
          runId,
          eventType: "workspace_artifacts_created",
          status: "succeeded",
          label: `Created ${artifacts.length} workspace artifact${artifacts.length === 1 ? "" : "s"}`,
          metadata: { artifacts },
        });
        try {
          const appDrafts = await createDraftAppVersionsForThreadArtifacts({
            db,
            userId,
            threadId,
            artifacts,
            sourceContentOmitted: appEditSourceOmitted,
          });
          appDraftVersions = appDrafts.summaries;
          if (appDrafts.created.length > 0 || appDrafts.rejected.length > 0) {
            await appendTurnRunEvent(lane, {
              db,
              runId,
              eventType: "app_draft_versions_created",
              status: appDrafts.rejected.length > 0 ? "failed" : "succeeded",
              label:
                appDrafts.created.length > 0
                  ? `Created ${appDrafts.created.length} draft app version${appDrafts.created.length === 1 ? "" : "s"}`
                  : "Rejected draft app versions",
              metadata: {
                draftVersions: appDraftVersions,
                rejected: appDrafts.rejected,
              },
            });
          }
        } catch (err) {
          process.stderr.write(
            `[app-draft-version-create-error] ${JSON.stringify({
              runId,
              threadId,
              assistantMessageId,
              message: err instanceof Error ? err.message : String(err),
            })}\n`,
          );
        }
      }
    } catch (err) {
      process.stderr.write(
        `[workspace-artifact-create-error] ${JSON.stringify({
          runId,
          threadId,
          assistantMessageId,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  }

  if (terminalStatus === "succeeded" && assistantMessageId) {
    try {
      recommendations = await createRecommendationsForAssistantMessage({
        db,
        userId,
        threadId,
        chatMessageId: assistantMessageId,
        runId,
        userMessageId,
        artifacts,
        suppressedSkillIds,
      });
    } catch (err) {
      process.stderr.write(
        `[recommendation-create-error] ${JSON.stringify({
          runId,
          threadId,
          assistantMessageId,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
  }

  if (lane.kind === "worker" && (await isRunCanceled(db, runId))) {
    return {
      assistantMessageId,
      artifacts,
      appDraftVersions,
      recommendations,
      sources,
    };
  }

  await refreshThreadPresentationMetadata({
    db,
    threadId,
    now: completedAt,
  });

  const usage = {
    tokensIn,
    tokensOut,
    inputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
  };
  const sharedOutputs = {
    assistantText,
    ...(assistantMessageId ? { assistantMessageId } : {}),
    userMessageId,
    toolCalls,
    toolResults,
    tokensIn,
    tokensOut,
    usage,
    modelId,
    runtime: runtimeName,
    ...(providerRunMetadata ? { providerRun: providerRunMetadata } : {}),
    ...(runtimeErrors.length > 0 ? { errorDetails: runtimeErrors } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(appDraftVersions.length > 0 ? { appDraftVersions } : {}),
    ...(recommendations.length > 0 ? { recommendations } : {}),
    ...(sources.length > 0 ? { sources } : {}),
  };
  const updatedRows = await db
    .update(runs)
    .set({
      status: terminalStatus,
      error,
      outputs:
        lane.kind === "inline"
          ? {
              ...sharedOutputs,
              requestedModelId: lane.requestedModelId,
              providerModelId: lane.modelSelection.providerModelId,
              modelSelection: lane.modelSelection,
              runtimeTarget,
              metrics: timingMetrics,
            }
          : { ...priorOutputs, ...sharedOutputs },
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: completedAt,
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      lane.kind === "worker"
        ? // #443: fenced on workerId — a worker that lost its lease to a
          // reclaim or admin resume must not overwrite the current owner.
          and(
            eq(runs.id, runId),
            ne(runs.status, "canceled"),
            eq(runs.workerId, lane.workerId),
          )
        : and(eq(runs.id, runId), ne(runs.status, "canceled")),
    )
    .returning({ id: runs.id });

  if (lane.kind === "worker") {
    // A concurrent cancel or a fencing loss won the terminal write; stop
    // here so a superseded execution never notifies or reports completion.
    if (updatedRows.length === 0) {
      return {
        assistantMessageId,
        artifacts,
        appDraftVersions,
        recommendations,
        sources,
      };
    }
    await createProactiveRunNotification(db, lane.run, terminalStatus, threadId);
  }

  if (terminalStatus === "succeeded" && assistantMessageId) {
    try {
      await enqueueMemoryCapture(db, {
        userId,
        threadId,
        fromMessageId: userMessageId,
        toMessageId: assistantMessageId,
        runId,
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

  await appendTurnRunEvent(lane, {
    db,
    runId,
    eventType: terminalStatus === "succeeded" ? "run_completed" : "run_failed",
    status: terminalStatus,
    label:
      terminalStatus === "succeeded"
        ? "Stored assistant answer"
        : "Run ended with errors",
    ...(error ? { error } : {}),
    metadata: {
      ...(assistantMessageId ? { assistantMessageId } : {}),
      userMessageId,
      modelId,
      runtime: runtimeName,
      runtimeTarget,
      ...(lane.kind === "inline"
        ? {
            requestedModelId: lane.requestedModelId,
            providerModelId: lane.modelSelection.providerModelId,
            modelSelection: lane.modelSelection,
          }
        : {}),
      usage,
      ...(runtimeErrors.length > 0 ? { errorDetails: runtimeErrors } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(appDraftVersions.length > 0 ? { appDraftVersions } : {}),
      ...(recommendations.length > 0 ? { recommendations } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      ...(timingMetrics ? { metrics: timingMetrics } : {}),
    },
  });

  return {
    assistantMessageId,
    artifacts,
    appDraftVersions,
    recommendations,
    sources,
  };
}

export async function isRunCanceled(
  db: Database,
  runId: string,
): Promise<boolean> {
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0]?.status === "canceled";
}

/** Worker-lane cancellation polling cadence during event streaming (#452). */
export const CANCELLATION_POLL_INTERVAL_MS = 2_000;

/**
 * Wraps an async cancellation probe so repeated calls poll at most once per
 * `intervalMs`: the first call polls immediately, calls inside the interval
 * return the last observed value, and a true result latches so cancellation
 * is never un-seen (and never re-polled).
 */
export function throttleCancellationCheck(
  isCanceled: () => Promise<boolean>,
  {
    intervalMs = CANCELLATION_POLL_INTERVAL_MS,
    now = Date.now,
  }: { intervalMs?: number; now?: () => number } = {},
): () => Promise<boolean> {
  let canceled = false;
  let lastPolledAt: number | undefined;
  return async () => {
    if (canceled) return true;
    const at = now();
    if (lastPolledAt !== undefined && at - lastPolledAt < intervalMs) {
      return false;
    }
    lastPolledAt = at;
    canceled = await isCanceled();
    return canceled;
  };
}

interface StoredChatRunOutputs {
  assistantText?: string;
  assistantMessageId?: string;
  providerRun?: RuntimeRunMetadata;
  [key: string]: unknown;
}

function parseStoredOutputs(value: unknown): StoredChatRunOutputs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as StoredChatRunOutputs;
}

function appendTurnRunEvent(
  lane: ChatTurnLane,
  input: Omit<AppendRunEventInput, "sequence">,
): Promise<void> {
  return appendRunEventBestEffort(
    lane.kind === "inline" ? "chat-inline-event-error" : "chat-run-event-error",
    input,
  );
}

export function buildTimingMetrics(
  timing: ChatRunTimingMarks,
): ChatRunTimingMetrics {
  const metrics: ChatRunTimingMetrics = {
    requestStartedAt: timing.requestStartedAt.toISOString(),
    inlineStartedAt: timing.inlineStartedAt.toISOString(),
    requestToInlineMs: diffMs(timing.requestStartedAt, timing.inlineStartedAt),
  };

  if (timing.contextReadyAt) {
    metrics.contextReadyAt = timing.contextReadyAt.toISOString();
    metrics.inlineToContextReadyMs = diffMs(
      timing.inlineStartedAt,
      timing.contextReadyAt,
    );
  }
  if (timing.providerStartedAt) {
    metrics.providerStartedAt = timing.providerStartedAt.toISOString();
    metrics.requestToProviderMs = diffMs(
      timing.requestStartedAt,
      timing.providerStartedAt,
    );
  }
  if (timing.firstTokenAt) {
    metrics.firstTokenAt = timing.firstTokenAt.toISOString();
    metrics.requestToFirstTokenMs = diffMs(
      timing.requestStartedAt,
      timing.firstTokenAt,
    );
    if (timing.providerStartedAt) {
      metrics.providerToFirstTokenMs = diffMs(
        timing.providerStartedAt,
        timing.firstTokenAt,
      );
    }
  }
  if (timing.completedAt) {
    metrics.completedAt = timing.completedAt.toISOString();
    metrics.requestToCompletedMs = diffMs(
      timing.requestStartedAt,
      timing.completedAt,
    );
  }

  return metrics;
}

function diffMs(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

export function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function dedupeUploadedFiles(
  files: readonly ChatContextUploadedFile[],
): ChatContextUploadedFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.resourceId
      ? `resource:${file.resourceId}`
      : `${file.name}\u0000${file.mimeType ?? ""}\u0000${file.sizeBytes ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
