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
import { serializeActivation } from "@ai-workspace/agent";
import {
  buildChatContextPack,
  type ChatContextUploadedFile,
} from "@/lib/chat-context-pack";
import { loadUserCapabilityGraph } from "@/lib/capability-graph";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import type { ToolActionLevel } from "@/lib/tool-policy";
import {
  toolDiscoveryModeFromEnv,
  type ChatRuntimeRoute,
} from "@/lib/chat-routing";
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
import {
  appendRunEventBestEffort,
  appendToolCallRunEvent,
  appendToolResultRunEvent,
  nextRunEventSequence,
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

export type ChatStreamSend = (event: Record<string, unknown>) => void;

export type ChatTurnTerminalStatus = "succeeded" | "failed";

export interface ChatRunTimingMarks {
  requestStartedAt: Date;
  inlineStartedAt: Date;
  contextReadyAt?: Date;
  providerStartedAt?: Date;
  firstTokenAt?: Date;
  completedAt?: Date;
}

export interface ChatRunTimingMetrics {
  requestStartedAt: string;
  inlineStartedAt: string;
  contextReadyAt?: string;
  providerStartedAt?: string;
  firstTokenAt?: string;
  completedAt?: string;
  requestToInlineMs: number;
  inlineToContextReadyMs?: number;
  requestToProviderMs?: number;
  providerToFirstTokenMs?: number;
  requestToFirstTokenMs?: number;
  requestToCompletedMs?: number;
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
  userMessageId,
  route,
  runtime,
  runtimeAbort,
  modelId,
  requestedProviders,
  activeSkillPrompt,
  uploadedFiles = [],
  suppressedSkillIds = [],
  interactive,
  lane,
}: ExecuteChatTurnInput): Promise<void> {
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
          ? buildArtifactLookupMessage(history, prompt, {
              preferFallback: lane.preferArtifactFallback,
            })
          : buildArtifactLookupMessage(history, prompt),
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
  const artifactContext = artifactContextPayload?.text ?? null;
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
  const agentMessages = attachUploadedFilesToLatestUserMessage(
    buildTurnContext({
      messages: history,
      currentMessageContent: prompt,
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
    }),
    uploadedFiles,
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
          prompt,
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

  const mountedProviders = mcpServers ? Object.keys(mcpServers) : [];
  // #384: sticky per-thread activation, resolved BEFORE the context pack
  // so the preamble/receipt tell the truth about what this turn mounts.
  // Parity mode activates every granted provider (byte-identical to
  // off); on-mode starts at the core bundle + discovery tools.
  const toolDiscoveryMode = toolDiscoveryModeFromEnv();
  const toolDiscovery =
    toolDiscoveryMode !== "off" && mountedProviders.length > 0
      ? await buildTurnToolDiscovery({
          db,
          thread,
          grantedProviders: mountedProviders,
          mode: toolDiscoveryMode,
          userMessage: prompt,
          skillProviders: requestedProviders,
        })
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
    threadSummary: thread.summary,
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
    uploadedFiles,
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
    ...(requiredToolName ? { requiredToolName } : {}),
    writeAuthorizationReceipts,
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
              prompt,
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

  try {
    // Tracks persisted activation across same-turn activations so a
    // second activate never unions against a stale snapshot.
    const grantedProviders = mountedProviders;
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
      providerTrace.record(ev);
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
          : await isRunCanceled(db, runId);
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
        if (persistedCall) {
          await appendToolCallRunEvent({
            db,
            runId,
            sequence: await nextRunEventSequence(db, runId),
            call: persistedCall,
          });
        }
        if (lane.kind === "inline") {
          // #359: stream the REDACTED copy — the live SSE previously sent
          // the raw runtime payload while only the persisted copy was
          // redacted, so a viewer's live stream could carry what replay
          // would have scrubbed.
          lane.send({ type: "tool-call", call: persistedCall ?? ev.call });
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
            runId,
            sequence: await nextRunEventSequence(db, runId),
            call: persistedCall,
            result: persistedResult,
          });
        }
        if (lane.kind === "inline") {
          // #359: redacted copy on the live stream too (see tool-call above).
          lane.send({
            type: "tool-result",
            result: persistedResult ?? ev.result,
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
    completedAt,
    priorOutputs,
    lane,
  });

  if (lane.kind === "inline") {
    lane.send({ type: "metrics", stage: "completed", metrics: finalMetrics });
    if (runError) return;
    lane.send({ type: "done" });
    lane.send({
      type: "persisted",
      assistantMessageId: persisted.assistantMessageId,
      tokensIn,
      tokensOut,
      artifacts: persisted.artifacts,
      appDraftVersions: persisted.appDraftVersions,
      recommendations: persisted.recommendations,
      runId,
      threadId: thread.id,
    });
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
  completedAt: Date;
  priorOutputs: StoredChatRunOutputs;
  lane: ChatTurnLane;
}): Promise<{
  assistantMessageId: string | undefined;
  artifacts: WorkspaceArtifactSummary[];
  appDraftVersions: AppDraftVersionSummary[];
  recommendations: PersistedRecommendation[];
}> {
  const empty = {
    assistantMessageId: undefined,
    artifacts: [],
    appDraftVersions: [],
    recommendations: [],
  };
  if (lane.kind === "worker" && (await isRunCanceled(db, runId))) return empty;

  // Worker resume reuses a message persisted by an earlier attempt.
  let assistantMessageId =
    lane.kind === "worker" ? priorOutputs.assistantMessageId : undefined;
  let artifacts: WorkspaceArtifactSummary[] = [];
  let appDraftVersions: AppDraftVersionSummary[] = [];
  let recommendations: PersistedRecommendation[] = [];
  const shouldPersistAssistant = shouldPersistAssistantMessage({
    terminalStatus,
    assistantText,
    toolCallsCount: toolCalls.length,
    toolResultsCount: toolResults.length,
  });

  if (!assistantMessageId && shouldPersistAssistant) {
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
    return { assistantMessageId, artifacts, appDraftVersions, recommendations };
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
    .where(and(eq(runs.id, runId), ne(runs.status, "canceled")))
    .returning({ id: runs.id });

  if (lane.kind === "worker") {
    // A concurrent cancel won the terminal write; stop here so a canceled
    // run never notifies or reports completion.
    if (updatedRows.length === 0) {
      return {
        assistantMessageId,
        artifacts,
        appDraftVersions,
        recommendations,
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
      ...(timingMetrics ? { metrics: timingMetrics } : {}),
    },
  });

  return { assistantMessageId, artifacts, appDraftVersions, recommendations };
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
