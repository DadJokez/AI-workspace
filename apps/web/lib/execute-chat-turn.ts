import {
  type ChatThread,
  auditLog,
  type Database,
  type Run,
  runs,
  users,
} from "@ai-workspace/db";
import { eq, ne, and } from "drizzle-orm";
import type {
  AgentRuntime,
  McpServerSpec,
  RuntimeRunMetadata,
} from "@ai-workspace/agent-runtime";
import {
  buildExactOutputContract,
  evaluateLiteralContract,
  extractAssistantSources,
  extractPureEchoReply,
  MODELS,
  serializeActivation,
  type AssistantSource,
  type ModelId,
  type ToolApprovalRequest as AgentToolApprovalRequest,
} from "@ai-workspace/agent";
import {
  buildChatContextPack,
  type ChatContextUploadedFile,
  type ChatContextWebAccessReceipt,
} from "@/lib/chat-context-pack";
import { loadUserCapabilityGraph } from "@/lib/capability-graph";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import type { ToolPolicyDecision } from "@/lib/tool-policy";
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
  hasDocumentCreationIntent,
} from "@/lib/artifact-context";
import {
  resolveArtifactContextTargets,
  type WorkspaceArtifactVersionTarget,
} from "@/lib/artifact-revisions";
import {
  artifactReviewContextForRequest,
  artifactReviewRequestFromRunInputs,
  completeArtifactReviewRequest,
  releaseArtifactReviewRequest,
} from "@/lib/artifact-review";
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
import {
  applyRuntimeModelFailover,
  type RuntimeModelSelection,
} from "@/lib/runtime-model-policy";
import {
  runTurnWithModelFailover,
  type ModelFailoverTransition,
} from "@/lib/model-failover";
import { createToolEventAccumulator } from "@/lib/tool-events";
import {
  consumeToolApproval,
  loadToolApprovalGrants,
  pauseRunForToolApprovals,
} from "@/lib/tool-approvals";
import { refreshThreadPresentationMetadata } from "@/lib/thread-metadata";
import { buildTurnContext } from "@/lib/turn-context";
import type { RecentToolEvidenceReceipt } from "@/lib/recent-tool-evidence";
import { attachUploadedFilesToLatestUserMessage } from "@/lib/runtime-attachments";
import { builtinToolsForChatRoute } from "@/lib/runtime-builtin-tools";
import {
  skillDeclaresWebAccess,
  skillMcpProviders,
} from "@/lib/skill-tool-declarations";
import { loadWebEgressPolicy } from "@/lib/web-egress-policy";
import { normalizeRuntimeUsage } from "@/lib/runtime-usage";
import {
  createProviderTraceAccumulator,
  persistProviderTraceCapture,
} from "@/lib/run-trace";
import {
  abortChatWorkerRuntime,
  chatWorkerAbortReason,
  type ChatWorkerAbortReason,
} from "@/lib/chat-worker-abort";
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
import { outputProposalContext } from "@/lib/output-proposals";
import {
  completeProposalIteration,
  outputProposalContextForIteration,
  proposalIterationFromRunInputs,
  releaseProposalIteration,
} from "@/lib/proposal-iterations";
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
import type { ContextResourceReference } from "@/lib/context-shelf";
import { resolveContextResources } from "@/lib/context-shelf-server";
import {
  loadThreadBranchArtifactContext,
  loadThreadPromptHistory,
} from "@/lib/thread-branches";

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
  modelId: ModelId;
  /** Enabled, bounded attempt order; the first entry is `modelId`. */
  modelCandidates?: readonly ModelId[];
  requestedProviders?: string[];
  activeSkillPrompt?: PinnedActiveSkill | null;
  uploadedFiles?: ChatContextUploadedFile[];
  resourceResolution?: ConversationResourceResolution;
  contextResourceReferences?: ContextResourceReference[];
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
  modelId: initialModelId,
  modelCandidates = [initialModelId],
  requestedProviders,
  activeSkillPrompt,
  uploadedFiles = [],
  resourceResolution,
  contextResourceReferences = [],
  userTimeZone,
  suppressedSkillIds = [],
  interactive,
  lane,
}: ExecuteChatTurnInput): Promise<void> {
  let modelId = initialModelId;
  const userInstruction = persistedPrompt ?? prompt;
  // #652/#644: the machine-checkable side of the exact-output contract. The
  // pure-echo fast path only engages when nothing beyond the message text
  // could change the answer — attachments, selected resources, or an active
  // skill all fall back to the normal model path.
  const exactOutputContract = buildExactOutputContract(userInstruction);
  const pureEchoReply =
    uploadedFiles.length === 0 &&
    !resourceResolution &&
    contextResourceReferences.length === 0 &&
    !activeSkillPrompt
      ? extractPureEchoReply(userInstruction)
      : undefined;
  const timing = lane.kind === "inline" ? lane.timing : undefined;
  const priorOutputs =
    lane.kind === "worker" ? parseStoredOutputs(lane.run.outputs) : {};
  const toolApprovalGrants = await loadToolApprovalGrants({
    db,
    runId,
    userId,
    runOutputs: priorOutputs,
  });
  const webAccessDeclared = skillDeclaresWebAccess(requestedProviders);
  const webAccessState = interactive || webAccessDeclared
    ? "granted"
    : "not_granted";
  const webAccessSource = interactive
    ? "interactive_default"
    : webAccessDeclared
      ? "skill_declaration"
      : "not_declared";
  const webAccess: Pick<
    ChatContextWebAccessReceipt,
    "state" | "source"
  > = {
    state: webAccessState,
    source: webAccessSource,
  };
  const builtinTools = builtinToolsForChatRoute(route, {
    interactive,
    webAccessDeclared,
  });
  const requestedMcpProviders = requestedProviders
    ? skillMcpProviders(requestedProviders)
    : undefined;
  const mcpProviderScope = resolveChatMcpProviderScope(
    requestedMcpProviders,
    route.routingMode,
  );
  // The worker lane has always mounted Vault context regardless of the
  // stored route; the interactive lane follows the route.
  const includeVaultContext =
    lane.kind === "worker" || route.includeVaultContext;

  const [
    userRows,
    history,
    vaultMarkdown,
    providerStatus,
    recentRecommendations,
    webEgressPolicy,
  ] = await Promise.all([
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
      loadThreadPromptHistory({ db, threadId: thread.id }),
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
      loadWebEgressPolicy(db),
    ]);
  const effectiveResourceResolution = resourceResolution
    ? await revalidateConversationResourceResolution({
        db,
        userId,
        threadId: thread.id,
        resolution: resourceResolution,
      })
    : undefined;

  const user = userRows[0] ?? {
    displayName: "User",
    assistantName: null,
    customInstructions: null,
    role: "user" as const,
  };

  // Match artifacts against recent RAW user messages, not the
  // attachment-folded prompt — so uploaded file bytes can't pull in an
  // unrelated artifact, while "it/that one" follow-ups still have context.
  const [
    artifactContextPayload,
    appEditContextResult,
    branchArtifactContext,
  ] = await Promise.all([
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
    loadThreadBranchArtifactContext({
      db,
      threadId: thread.id,
      actor: { id: userId, role: user.role },
    }),
  ]);
  let { artifactContextTarget, separateFromArtifact } =
    resolveArtifactContextTargets(
      lane.kind === "worker"
        ? {
            payload: artifactContextPayload,
            storedArtifactTarget: lane.storedArtifactTarget,
            storedSeparateFromArtifact: lane.storedSeparateFromArtifact,
          }
        : { payload: artifactContextPayload },
    );
  const branchSourceMatched =
    Boolean(branchArtifactContext) &&
    artifactContextPayload?.matchedArtifact?.id ===
      branchArtifactContext?.sourceArtifactId;
  const useBranchArtifactContext =
    Boolean(branchArtifactContext) &&
    (!artifactContextPayload?.matchedArtifact || branchSourceMatched);
  if (
    useBranchArtifactContext &&
    (!artifactContextTarget || branchSourceMatched) &&
    (!separateFromArtifact || branchSourceMatched)
  ) {
    artifactContextTarget = null;
    separateFromArtifact = branchArtifactContext?.separateFromArtifact ?? null;
  }
  const artifactContext = useBranchArtifactContext
    ? null
    : artifactContextTextForTurn({
        payload: artifactContextPayload,
        uploadedFiles,
      });
  const parsedArtifactReviewRequest =
    lane.kind === "worker"
      ? artifactReviewRequestFromRunInputs(lane.storedInputs)
      : null;
  const artifactReviewRequest =
    parsedArtifactReviewRequest?.runId === runId
      ? parsedArtifactReviewRequest
      : null;
  const artifactReviewContext = artifactReviewRequest
    ? artifactReviewContextForRequest(artifactReviewRequest)
    : null;
  const appEditContext = appEditContextResult?.context ?? null;
  const appEditSourceOmitted =
    appEditContextResult?.sourceContentOmitted ?? false;
  const combinedArtifactContext = [
    appEditContext,
    useBranchArtifactContext ? branchArtifactContext?.text : null,
    artifactContext,
    artifactReviewContext,
  ]
    .filter(Boolean)
    .join("\n\n");

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

  let mcpServers: Record<string, McpServerSpec> | undefined;
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
          skillProviders: requestedMcpProviders,
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
  const activeMountedProviders = toolDiscovery
    ? toolDiscovery.activatedProviders
    : mountedProviders;
  const selectedContext = await resolveContextResources({
    db,
    user: { id: userId, role: user.role },
    threadId: thread.id,
    references: contextResourceReferences,
    conversationResources: effectiveResourceResolution,
    conversationResourceMounted: activeMountedProviders.includes(
      CONVERSATION_RESOURCE_PROVIDER,
    ),
    inlineConversationResourceIds: runtimeUploadedFiles.flatMap((file) =>
      file.resourceId ? [file.resourceId] : [],
    ),
    runtimeProviders: {
      mountedProviders: activeMountedProviders,
      discoverableProviders,
      blockedProviders,
      providerAvailability: providerStatus.providerAvailability,
    },
  });

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
    mountedProviders: activeMountedProviders,
    discoverableProviders,
    deniedMcpProviders,
    capabilityGraph,
    modelId,
    artifactContext: combinedArtifactContext,
    uploadedFiles: runtimeUploadedFiles,
    recentToolEvidenceReceipt,
    resourceResolution: effectiveResourceResolution,
    selectedContextManifest: selectedContext.manifest,
    selectedContextPrompt: selectedContext.promptContext,
    recommendations: recentRecommendations,
    route,
    builtinTools,
    webAccess: {
      ...webAccess,
      policy: webEgressPolicy.name,
      deniedDomainCount: webEgressPolicy.deniedDomains.length,
    },
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
    webAccess: {
      ...webAccess,
      policy: webEgressPolicy.name,
      deniedDomainCount: webEgressPolicy.deniedDomains.length,
    },
    ...(effectiveResourceResolution
      ? { resourceResolution: effectiveResourceResolution }
      : {}),
    contextResourceReferences,
    contextResourceManifest: selectedContext.manifest,
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
  const currentErrorContext = () => ({
    runtime: runtime.name,
    runtimeTarget: route.runtimeTarget,
    requestedModelId:
      lane.kind === "inline"
        ? lane.modelSelection.requestedModelId
        : initialModelId,
    modelId,
    ...(lane.kind === "inline" && lane.modelSelection.providerModelId
      ? { providerModelId: lane.modelSelection.providerModelId }
      : {}),
  });
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
  const buildWorkerTelemetryOutput = () => ({
    ...priorOutputs,
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
    lifecycle: "provider_running",
  });

  // #452: the worker lane used to SELECT the run row once per streamed
  // event — including every text-delta. Throttled to a cheap cadence; the
  // post-stream isRunCanceled checks keep the terminal semantics exact.
  const workerCanceled = throttleCancellationCheck(() =>
    isRunCanceled(db, runId),
  );
  let providerTerminalSeen = false;
  let providerStreamTruncated = false;
  let pendingToolApprovalRequests: AgentToolApprovalRequest[] = [];
  const failoverCandidates = [
    ...new Set<ModelId>([modelId, ...modelCandidates]),
  ];

  const recordModelFailover = async ({
    fromModelId,
    toModelId,
    error,
    attempt,
  }: ModelFailoverTransition) => {
    const normalized = normalizeRuntimeError(error, {
      runtime: runtime.name,
      runtimeTarget: route.runtimeTarget,
      requestedModelId:
        lane.kind === "inline"
          ? lane.modelSelection.requestedModelId
          : initialModelId,
      modelId: fromModelId,
      providerModelId: MODELS[fromModelId].bedrockModelId,
    });
    const now = new Date();
    await db.transaction(async (tx) => {
      const updatedRows = await tx
        .update(runs)
        .set({ modelId: toModelId, updatedAt: now })
        .where(
          lane.kind === "worker"
            ? and(
                eq(runs.id, runId),
                eq(runs.status, "running"),
                eq(runs.workerId, lane.workerId),
              )
            : and(eq(runs.id, runId), eq(runs.status, "running")),
        )
        .returning({ id: runs.id });
      if (updatedRows.length === 0) {
        throw new Error("The run stopped before model failover could start.");
      }
      await tx.insert(auditLog).values({
        actorUserId: userId,
        actionType: "model_failover",
        status: "succeeded",
        provider: MODELS[toModelId].provider,
        chatThreadId: thread.id,
        runId,
        input: {
          modelId: fromModelId,
          providerModelId: MODELS[fromModelId].bedrockModelId,
          errorCode: normalized.code,
          errorCategory: normalized.category,
        },
        output: {
          modelId: toModelId,
          providerModelId: MODELS[toModelId].bedrockModelId,
          attempt,
        },
        metadata: {
          runtime: runtime.name,
          runtimeTarget: route.runtimeTarget,
          triggerError: normalized.userMessage,
        },
        startedAt: now,
        completedAt: now,
      });
    });

    modelId = toModelId;
    if (lane.kind === "inline") {
      lane.modelSelection = applyRuntimeModelFailover(
        lane.modelSelection,
        toModelId,
        fromModelId,
        attempt,
      );
    }

    await appendTurnRunEvent(lane, {
      db,
      runId,
      eventType: "model_failover",
      status: "succeeded",
      label: `Failed over from ${fromModelId} to ${toModelId}`,
      metadata: {
        fromModelId,
        fromProviderModelId: MODELS[fromModelId].bedrockModelId,
        toModelId,
        toProviderModelId: MODELS[toModelId].bedrockModelId,
        attempt,
        errorCode: normalized.code,
        errorCategory: normalized.category,
        runtime: runtime.name,
        runtimeTarget: route.runtimeTarget,
      },
      occurredAt: now,
    });

    if (lane.kind === "inline") {
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
    }
  };

  const streamProviderTurn = async () => {
    // Tracks persisted activation across same-turn activations so a
    // second activate never unions against a stale snapshot.
    const grantedProviders = accountMcpProviders;
    let activationSignature = serializeActivation(
      toolDiscovery?.activatedProviders ?? [],
    );

    for await (const ev of runTurnWithModelFailover({
      runtime,
      candidates: failoverCandidates,
      onFailover: recordModelFailover,
      input: {
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
        webEgressPolicy,
        ...(requiredToolName ? { requiredToolName } : {}),
        ...(toolDiscovery ? { toolDiscovery } : {}),
        ...(toolApprovalGrants.length > 0 ? { toolApprovalGrants } : {}),
      },
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
        if (lane.kind === "worker") {
          abortChatWorkerRuntime(runtimeAbort, "canceled");
        } else {
          runtimeAbort.abort();
        }
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
        } else {
          // Worker runs have no SSE connection. Persist the same aggregate
          // behind the active lease so the slim status poll can update the
          // footer without reloading messages, artifacts, or event details.
          await db
            .update(runs)
            .set({
              outputs: buildWorkerTelemetryOutput(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(runs.id, runId),
                eq(runs.status, "running"),
                eq(runs.workerId, lane.workerId),
              ),
            );
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
      } else if (ev.type === "tool-approval-required") {
        pendingToolApprovalRequests = ev.requests;
      } else if (ev.type === "tool-approval-consumed") {
        await consumeToolApproval({
          db,
          approvalId: ev.approvalId,
          runId,
          userId,
        });
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
        if (ev.degradedProvider) {
          // #713: one provider failed to mount but the turn continued with
          // the remaining tools — degraded, not failed. Record it on the run
          // (receipts) and the worker log so the outcome is never silent,
          // but do not mark the run failed and do not send a stream error:
          // the client treats any streamed error as a failed turn, and the
          // model tells the user honestly in the answer itself.
          await appendTurnRunEvent(lane, {
            db,
            runId,
            eventType: "mcp_provider_mount_failed",
            status: "failed",
            label: `MCP provider ${ev.degradedProvider} failed to mount; the turn continued with the remaining tools`,
            provider: ev.degradedProvider,
            error: ev.message,
          });
          if (lane.kind === "worker") {
            process.stderr.write(
              `[chat-run-worker-mcp-mount-degraded] ${JSON.stringify({
                runId,
                threadId: thread.id,
                provider: ev.degradedProvider,
                message: ev.message,
              })}\n`,
            );
          }
        } else {
          const normalized = normalizeRuntimeError(
            ev.message,
            currentErrorContext(),
          );
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
    }
  };

  try {
    if (pureEchoReply !== undefined) {
      // #644: the whole message demands one delimited literal — answer it
      // deterministically instead of asking a model to echo it (and risking
      // an injection-hardening false refusal). The turn persists, succeeds,
      // and queues memory capture exactly like a model turn.
      assistantText = pureEchoReply;
      providerTerminalSeen = true;
      if (lane.kind === "inline") {
        lane.timing.firstTokenAt = new Date();
        lane.send({ type: "text-delta", delta: pureEchoReply });
      }
      await appendTurnRunEvent(lane, {
        db,
        runId,
        eventType: "exact_output_fast_path",
        status: "succeeded",
        label: "Answered a pure echo request without a model call",
        metadata: { literalChars: pureEchoReply.length },
      });
    } else {
      await streamProviderTurn();
    }
  } catch (err) {
    if (lane.kind === "worker") {
      if (await isRunCanceled(db, runId)) {
        abortChatWorkerRuntime(runtimeAbort, "canceled");
      } else if (!runtimeAbort.signal.aborted) {
        await persistProviderTraceCapture({
          db,
          runId,
          capture: providerTrace.snapshot(),
        });
        // The worker shell marks the run failed and notifies.
        throw err;
      }
    } else {
      const normalized = normalizeRuntimeError(err, currentErrorContext());
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

  if (pendingToolApprovalRequests.length > 0) {
    const pauseOutputs =
      lane.kind === "worker"
        ? buildWorkerOutput()
        : {
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
            requestedModelId: lane.requestedModelId,
            modelId,
            providerModelId: lane.modelSelection.providerModelId,
            modelSelection: lane.modelSelection,
            runtime: runtime.name,
            runtimeTarget: route.runtimeTarget,
            ...(providerRunMetadata ? { providerRun: providerRunMetadata } : {}),
            metrics: buildTimingMetrics(lane.timing),
          };
    const approvals = await pauseRunForToolApprovals({
      db,
      runId,
      userId,
      threadId: thread.id,
      requests: pendingToolApprovalRequests,
      calls: toolEvents.calls(),
      outputs: pauseOutputs,
      ...(lane.kind === "worker" ? { expectedWorkerId: lane.workerId } : {}),
    });
    await persistProviderTraceCapture({
      db,
      runId,
      capture: providerTrace.snapshot(),
      metadata: { lifecycle: "waiting_for_approval" },
    });
    await appendTurnRunEvent(lane, {
      db,
      runId,
      eventType: "tool_approval_required",
      status: "pending",
      label: `Waiting for approval to run ${approvals.length} tool ${approvals.length === 1 ? "action" : "actions"}`,
      metadata: {
        batchId: approvals[0]?.batchId,
        approvalIds: approvals.map((approval) => approval.id),
        tools: approvals.map((approval) => ({
          provider: approval.provider,
          toolName: approval.nativeToolName ?? approval.toolName,
        })),
      },
    });
    if (lane.kind === "inline") {
      lane.send({ type: "tool-approval-required", requests: approvals });
      lane.send({ type: "done", stopReason: "approval_required" });
    }
    return;
  }

  if (
    !providerTerminalSeen &&
    !runtimeAbort.signal.aborted &&
    runtimeErrors.length === 0
  ) {
    providerStreamTruncated = true;
    const normalized = normalizeRuntimeError(
      "The model response ended before its completion event. Please try again.",
      currentErrorContext(),
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

  const workerAbortReason =
    lane.kind === "worker"
      ? chatWorkerAbortReason(runtimeAbort.signal)
      : null;

  if (lane.kind === "worker" && (await isRunCanceled(db, runId))) {
    await persistProviderTraceCapture({
      db,
      runId,
      capture: providerTrace.snapshot(),
      metadata: { abortReason: "canceled" },
    });
    await appendTurnRunEvent(lane, {
      db,
      runId,
      eventType: "worker_stopped_after_cancel",
      status: "failed",
      label: "Worker stopped after cancellation",
      metadata: {
        abortReason: "canceled",
        ...(workerAbortReason && workerAbortReason !== "canceled"
          ? { runtimeAbortReason: workerAbortReason }
          : {}),
        cancellationObservedVia: "database_poll",
        runtimeRequestAbortAttempted: runtimeAbort.signal.aborted,
        providerSessionStopAttempted: false,
      },
    });
    return;
  }

  if (lane.kind === "worker" && workerAbortReason === "lease_lost") {
    await persistProviderTraceCapture({
      db,
      runId,
      capture: providerTrace.snapshot(),
      metadata: { abortReason: workerAbortReason },
    });
    await appendTurnRunEvent(lane, {
      db,
      runId,
      eventType: "worker_stopped_after_lease_loss",
      status: "info",
      label: "Prior worker stopped after losing its run lease",
      metadata: {
        abortReason: workerAbortReason,
        workerId: lane.workerId,
        runtimeRequestAbortAttempted: true,
        providerSessionStopAttempted: false,
      },
    });
    return;
  }

  const abortError =
    lane.kind === "inline"
      ? lane.signal?.aborted
        ? "Browser request disconnected before the local chat run completed."
        : null
      : runtimeAbort.signal.aborted
        ? workerAbortMessage(workerAbortReason, lane.timeoutMs)
        : null;
  const runError =
    abortError ??
    (runtimeErrors.length > 0
      ? runtimeErrors.map((err) => err.userMessage).join("\n")
      : null);

  // #652: enforce the literal contract at the only seam that can — after the
  // stream, before persistence. A literal wrapped in prose is reduced
  // deterministically (no model retry); an absent literal is never invented,
  // only flagged on the run outputs so evals and receipts can see it.
  let assistantTextReduced = false;
  let contractViolation: "literal_missing" | undefined;
  if (exactOutputContract?.spec && !runError && assistantText.length > 0) {
    const literal = exactOutputContract.spec.value;
    const rawOutcome = evaluateLiteralContract(assistantText, literal);
    // A non-reducible spec (content-producing prefix, e.g. "Summarize the
    // doc. Reply exactly: done") must never have the requested content
    // discarded over an incidental substring hit — the answer stands.
    const outcome =
      rawOutcome === "reduced" && !exactOutputContract.spec.reducible
        ? "present"
        : rawOutcome;
    if (outcome === "reduced") {
      assistantText = literal;
      assistantTextReduced = true;
    } else if (outcome === "violated") {
      contractViolation = "literal_missing";
    }
    if (outcome !== "exact" && outcome !== "present") {
      await appendTurnRunEvent(lane, {
        db,
        runId,
        eventType:
          outcome === "reduced"
            ? "exact_output_reduced"
            : "exact_output_contract_violation",
        status: outcome === "reduced" ? "succeeded" : "info",
        label:
          outcome === "reduced"
            ? "Reduced the answer to the demanded literal"
            : "Answer did not contain the demanded literal",
        metadata: { literalChars: literal.length },
      });
    }
  }
  const completedAt = new Date();
  if (timing) timing.completedAt = completedAt;
  const finalMetrics = timing ? buildTimingMetrics(timing) : undefined;
  await persistProviderTraceCapture({
    db,
    runId,
    capture: providerTrace.snapshot(completedAt),
    ...(workerAbortReason
      ? { metadata: { abortReason: workerAbortReason } }
      : {}),
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
    toolPolicyDecisions: providerStatus.toolPolicyDecisions,
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
    // #647: classified from the raw user turn, not the model's answer, so a
    // fenced block the model emits for a pure formatting request is not
    // persisted as an artifact.
    documentCreationIntent: hasDocumentCreationIntent(userInstruction),
    appEditSourceOmitted,
    suppressAssistantPersistence: providerStreamTruncated,
    contractViolation,
    completedAt,
    priorOutputs,
    lane,
    abortReason: workerAbortReason ?? undefined,
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
      contextResourceManifest: selectedContext.manifest,
      runId,
      threadId: thread.id,
      // The streamed deltas carried the wrapped answer; the reduced literal
      // is the persisted final answer, so the client must replace, not keep.
      ...(assistantTextReduced ? { content: assistantText } : {}),
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
  toolPolicyDecisions,
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
  documentCreationIntent,
  appEditSourceOmitted,
  suppressAssistantPersistence,
  contractViolation,
  completedAt,
  priorOutputs,
  lane,
  abortReason,
}: {
  db: Database;
  runId: string;
  userId: string;
  threadId: string;
  userMessageId: string;
  modelId: string;
  runtimeName: string;
  runtimeTarget: ChatRuntimeRoute["runtimeTarget"];
  toolPolicyDecisions?: Record<string, ToolPolicyDecision>;
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
  /** #647: whether the user's turn asked for a saved document/file at all. */
  documentCreationIntent: boolean;
  appEditSourceOmitted: boolean;
  suppressAssistantPersistence: boolean;
  /** #652: the answer never contained the demanded literal. */
  contractViolation?: "literal_missing";
  completedAt: Date;
  priorOutputs: StoredChatRunOutputs;
  lane: ChatTurnLane;
  abortReason?: ChatWorkerAbortReason;
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
  let sources =
    terminalStatus === "succeeded"
      ? extractAssistantSources({ toolCalls, toolResults })
      : [];
  const proposalIteration =
    lane.kind === "worker"
      ? proposalIterationFromRunInputs(lane.storedInputs)
      : null;
  const parsedArtifactReviewRequest =
    lane.kind === "worker"
      ? artifactReviewRequestFromRunInputs(lane.storedInputs)
      : null;
  const artifactReviewRequest =
    parsedArtifactReviewRequest?.runId === runId
      ? parsedArtifactReviewRequest
      : null;
  const proposal =
    lane.kind === "worker"
      ? proposalIteration
        ? outputProposalContextForIteration(proposalIteration, completedAt)
        : outputProposalContext({
            runId,
            triggerType: lane.run.triggerType,
            createdAt: completedAt,
          })
      : null;
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
      toolPolicyDecisions,
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
        proposal,
        documentCreationIntent,
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
            proposal,
          });
          appDraftVersions = appDrafts.summaries;
          if (appDrafts.created.length > 0 || appDrafts.rejected.length > 0) {
            await appendTurnRunEvent(lane, {
              db,
              runId,
              eventType: "app_draft_validation_completed",
              status: appDrafts.rejected.length > 0 ? "failed" : "succeeded",
              label:
                appDrafts.rejected.length > 0
                  ? "App draft validation failed"
                  : `Validated ${appDrafts.created.length} app draft${appDrafts.created.length === 1 ? "" : "s"}`,
              metadata: {
                check: "app source and ownership",
                passed: appDrafts.created.length,
                failed: appDrafts.rejected.length,
                filenames: artifacts.map((artifact) => artifact.filename),
                failureReasons: appDrafts.rejected.map(
                  (rejected) => rejected.reason,
                ),
              },
            });
            if (appDrafts.created.length > 0) {
              await appendTurnRunEvent(lane, {
                db,
                runId,
                eventType: "app_draft_versions_created",
                status: "succeeded",
                label: `Created ${appDrafts.created.length} draft app version${appDrafts.created.length === 1 ? "" : "s"}`,
                metadata: { draftVersions: appDraftVersions },
              });
            }
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

  if (proposalIteration) {
    let iterationError =
      terminalStatus === "failed"
        ? error ?? "The proposal iteration run failed."
        : null;
    if (!iterationError) {
      const replacementArtifact = artifacts.find(
        (artifact) =>
          artifact.artifactGroupId ===
            proposalIteration.sourceArtifactGroupId &&
          artifact.supersedesArtifactId ===
            proposalIteration.sourceArtifactId,
      );
      const replacementAppVersion =
        proposalIteration.kind === "app" && replacementArtifact
          ? appDraftVersions.find(
              (version) =>
                version.appId === proposalIteration.sourceAppId &&
                version.artifactId === replacementArtifact.id &&
                version.status === "proposed",
            )
          : undefined;
      if (!replacementArtifact) {
        iterationError =
          "The run finished without creating a replacement proposal.";
      } else if (
        proposalIteration.kind === "app" &&
        !replacementAppVersion
      ) {
        iterationError =
          "The run did not create a valid replacement app proposal.";
      } else {
        const completed = await completeProposalIteration({
          db,
          iteration: proposalIteration,
          replacementArtifact,
          replacementAppVersion,
          completedAt,
          expectedWorkerId:
            lane.kind === "worker" ? lane.workerId : undefined,
        });
        if (!completed) {
          iterationError =
            "The original proposal changed before the replacement could be saved.";
        }
      }
    }

    if (iterationError) {
      const failedArtifactIds = artifacts.map((artifact) => artifact.id);
      await releaseProposalIteration({
        db,
        iteration: proposalIteration,
        error: iterationError,
        completedAt,
        expectedWorkerId:
          lane.kind === "worker" ? lane.workerId : undefined,
        replacementArtifactIds: failedArtifactIds,
      });
      artifacts = [];
      appDraftVersions = [];
      sources = [];
      terminalStatus = "failed";
      error = iterationError;
      await appendTurnRunEvent(lane, {
        db,
        runId,
        eventType: "proposal_iteration_failed",
        status: "failed",
        label: "Proposal iteration failed",
        error: iterationError,
        metadata: {
          sourceArtifactId: proposalIteration.sourceArtifactId,
          failedArtifactIds,
        },
      });
    } else {
      await appendTurnRunEvent(lane, {
        db,
        runId,
        eventType: "proposal_iteration_completed",
        status: "succeeded",
        label: "Created replacement proposal",
        metadata: {
          sourceArtifactId: proposalIteration.sourceArtifactId,
          replacementArtifactIds: artifacts.map((artifact) => artifact.id),
        },
      });
    }
  }

  if (artifactReviewRequest) {
    let reviewError =
      terminalStatus === "failed"
        ? error ?? "The artifact review run failed."
        : null;
    const replacementArtifact = artifacts.find(
      (artifact) =>
        artifact.artifactGroupId ===
          artifactReviewRequest.sourceArtifactGroupId &&
        artifact.supersedesArtifactId ===
          artifactReviewRequest.sourceArtifactId,
    );
    if (!reviewError && !replacementArtifact) {
      reviewError =
        "The run finished without creating a revision from the reviewed version.";
    }
    if (!reviewError && replacementArtifact) {
      const completed = await completeArtifactReviewRequest({
        db,
        request: artifactReviewRequest,
        replacementArtifact,
        completedAt,
        expectedWorkerId:
          lane.kind === "worker" ? lane.workerId : undefined,
      });
      if (!completed) {
        reviewError =
          "The reviewed version or selected comments changed before the revision could be saved.";
      } else {
        replacementArtifact.metadata = {
          ...(replacementArtifact.metadata ?? {}),
          artifactReview: {
            sourceArtifactId: artifactReviewRequest.sourceArtifactId,
            sourceArtifactVersionNumber:
              artifactReviewRequest.sourceArtifactVersionNumber,
            commentIds: artifactReviewRequest.comments.map(
              (comment) => comment.id,
            ),
            requestedAt: artifactReviewRequest.requestedAt,
            requestedByUserId: artifactReviewRequest.requestedByUserId,
            completedAt: completedAt.toISOString(),
          },
        };
      }
    }

    if (reviewError) {
      const failedArtifactIds = artifacts.map((artifact) => artifact.id);
      await releaseArtifactReviewRequest({
        db,
        request: artifactReviewRequest,
        error: reviewError,
        completedAt,
        expectedWorkerId:
          lane.kind === "worker" ? lane.workerId : undefined,
        replacementArtifactIds: failedArtifactIds,
      });
      artifacts = [];
      appDraftVersions = [];
      sources = [];
      terminalStatus = "failed";
      error = reviewError;
      await appendTurnRunEvent(lane, {
        db,
        runId,
        eventType: "artifact_review_failed",
        status: "failed",
        label: "Artifact review revision failed",
        error: reviewError,
        metadata: {
          sourceArtifactId: artifactReviewRequest.sourceArtifactId,
          commentIds: artifactReviewRequest.comments.map(
            (comment) => comment.id,
          ),
          failedArtifactIds,
        },
      });
    } else {
      await appendTurnRunEvent(lane, {
        db,
        runId,
        eventType: "artifact_review_completed",
        status: "succeeded",
        label: "Addressed selected review comments",
        metadata: {
          sourceArtifactId: artifactReviewRequest.sourceArtifactId,
          commentIds: artifactReviewRequest.comments.map(
            (comment) => comment.id,
          ),
          replacementArtifactId: replacementArtifact?.id,
        },
      });
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
    ...(abortReason ? { abortReason } : {}),
    ...(runtimeErrors.length > 0 ? { errorDetails: runtimeErrors } : {}),
    ...(contractViolation ? { contractViolation } : {}),
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
    await createProactiveRunNotification(
      db,
      lane.run,
      terminalStatus,
      threadId,
      { hasProposal: proposal !== null && artifacts.length > 0 },
    );
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
      ...(abortReason ? { abortReason } : {}),
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

function workerAbortMessage(
  reason: ChatWorkerAbortReason | null,
  timeoutMs: number,
): string {
  if (reason === "timeout") {
    return `Chat runtime timed out after ${timeoutMs}ms.`;
  }
  if (reason === "shutdown") {
    return "Background worker stopped because the service is shutting down.";
  }
  if (reason === "canceled") {
    return "Chat run was canceled before the provider finished.";
  }
  return "Background worker stopped before the chat run completed.";
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
