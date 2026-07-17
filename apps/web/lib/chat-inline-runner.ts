import {
  type ChatThread,
  auditLog,
  chatMessages,
  type Database,
  runs,
  users,
} from "@ai-workspace/db";
import { eq, ne, and, asc, sql } from "drizzle-orm";
import {
  getRuntime,
  type RuntimeName,
  type RuntimeRunMetadata,
} from "@ai-workspace/agent-runtime";
import {
  buildChatContextPack,
  type ChatContextUploadedFile,
} from "@/lib/chat-context-pack";
import { loadUserCapabilityGraph } from "@/lib/capability-graph";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import {
  toolDiscoveryModeFromEnv,
  type ChatRuntimeRoute,
} from "@/lib/chat-routing";
import { serializeActivation } from "@ai-workspace/agent";
import { persistActivationFromEvent } from "@/lib/thread-activation";
import { buildTurnToolDiscovery } from "@/lib/tool-discovery";
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
  appendRunEventWithNextSequence,
  appendToolCallRunEvent,
  appendToolResultRunEvent,
} from "@/lib/run-events";
import {
  normalizeRuntimeError,
  type NormalizedRuntimeError,
} from "@/lib/runtime-errors";
import { enabledModelsForPurpose } from "@/lib/model-registry";
import {
  resolveRuntimeModelSelection,
  type RuntimeModelSelection,
} from "@/lib/runtime-model-policy";
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
  modelOverride?: boolean;
  route: ChatRuntimeRoute;
  activatedSkills?: Array<Record<string, unknown>>;
  requestedProviders?: string[];
  uploadedFiles?: ChatContextUploadedFile[];
  requestStartedAt?: Date;
  signal?: AbortSignal;
  send: ChatStreamSend;
  diagnosticStreamEnabled?: boolean;
}

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

export async function streamInlineChatRun({
  db,
  runId,
  thread,
  userId,
  userMessageId,
  prompt,
  modelId,
  modelOverride = false,
  route,
  activatedSkills,
  requestedProviders,
  uploadedFiles = [],
  requestStartedAt,
  signal,
  send,
  diagnosticStreamEnabled = false,
}: StreamInlineChatRunInput): Promise<void> {
  const timing: ChatRunTimingMarks = {
    requestStartedAt: requestStartedAt ?? new Date(),
    inlineStartedAt: new Date(),
  };
  const runtimeName = resolveRuntimeName(route);
  // #300: this turn may only use models enabled for its lane's purpose.
  const modelSelection = resolveRuntimeModelSelection({
    requestedModelId: modelId,
    route,
    runtimeName,
    message: prompt,
    forceRequestedModel: modelOverride,
    enabledModelIds: new Set(await enabledModelsForPurpose(db, route.lane)),
  });
  const runtimeModelId = modelSelection.modelId;
  const runtime = getRuntime({
    runtime: runtimeName,
  });
  const runtimeAbort = new AbortController();
  const externalAbort = () => runtimeAbort.abort();
  signal?.addEventListener("abort", externalAbort, { once: true });

  let assistantText = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let inputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let providerRunMetadata: RuntimeRunMetadata | null = null;
  const runtimeErrors: NormalizedRuntimeError[] = [];
  const toolEvents = createToolEventAccumulator([]);
  const providerTrace = createProviderTraceAccumulator();
  const builtinTools = builtinToolsForChatRoute(route);

  try {
    const mcpProviderScope = resolveChatMcpProviderScope(
      requestedProviders,
      route.routingMode,
    );
    const [
      userRows,
      history,
      vaultMarkdown,
      providerStatus,
      recentRecommendations,
    ] =
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
        route.includeVaultContext
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
        message: buildArtifactLookupMessage(history, prompt),
      }),
      buildAppEditContext({ db, userId, threadId: thread.id }),
    ]);
    const { artifactContextTarget, separateFromArtifact } =
      resolveArtifactContextTargets({ payload: artifactContextPayload });
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
    if (route.useMcp) {
      try {
        const mcpAccess = await buildUserMcpServers(
          db,
          userId,
          {
            ...mcpProviderScope.mountOptions,
            turnContext: {
              runId,
              threadId: thread.id,
              prompt,
              history,
              interactive: true,
            },
          },
        );
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
    const contextPack = buildChatContextPack({
      user,
      messages: agentMessages,
      threadSummary: thread.summary,
      vaultMarkdown,
      vaultContextRequested: route.includeVaultContext,
      providerStatus,
      mountedProviders: toolDiscovery
        ? toolDiscovery.activatedProviders
        : mountedProviders,
      discoverableProviders,
      deniedMcpProviders,
      capabilityGraph,
      modelId: runtimeModelId,
      artifactContext: combinedArtifactContext,
      uploadedFiles,
      recommendations: recentRecommendations,
      route,
      builtinTools,
    });
    const contextReceipt = contextPack.receipts[0]!;
    timing.contextReadyAt = new Date();

    await db
      .update(runs)
      .set({
        modelId: runtimeModelId,
        runtime: runtime.name,
        inputs: {
          prompt,
          threadId: thread.id,
          userMessageId,
          requestedByUserId: userId,
          requestedModelId: modelId,
          modelOverride,
          runtimeModelId,
          providerModelId: modelSelection.providerModelId,
          modelSelection,
          runtimeTarget: route.runtimeTarget,
          executionMode: route.executionMode,
          runtimeRoute: route,
          ...(activatedSkills ? { activatedSkills } : {}),
          ...(requestedProviders ? { requestedProviders } : {}),
          mcpProviders: mountedProviders,
          ...(requiredToolName ? { requiredToolName } : {}),
          writeAuthorizationReceipts,
          accountConnectedMcpProviders: providerStatus.connectedProviders,
          approvedMcpProviders: providerStatus.allowedProviders,
          deniedMcpProviders: blockedProviders,
          contextReceipt,
          ...(artifactContextTarget ? { artifactContextTarget } : {}),
          ...(separateFromArtifact ? { separateFromArtifact } : {}),
          metrics: buildTimingMetrics(timing),
        },
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId));

    await appendInlineRunEvent(db, runId, {
      eventType: "context_pack_assembled",
      status: "succeeded",
      label: "Assembled context pack",
      metadata: { contextReceipt, writeAuthorizationReceipts },
    });

    await appendInlineRunEvent(db, runId, {
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
        requestedModelId: modelId,
        modelOverride,
        runtimeModelId,
        providerModelId: modelSelection.providerModelId,
        modelSelection,
        reasons: route.reasons,
        mcpProviders: mountedProviders,
        ...(requiredToolName ? { requiredToolName } : {}),
        writeAuthorizationReceipts,
        accountConnectedMcpProviders: providerStatus.connectedProviders,
        approvedMcpProviders: providerStatus.allowedProviders,
        deniedMcpProviders: blockedProviders,
        contextReceipt,
        metrics: buildTimingMetrics(timing),
      },
    });

    send({
      type: "model",
      requestedModelId: modelId,
      modelOverride,
      modelId: runtimeModelId,
      providerModelId: modelSelection.providerModelId,
      modelSelection,
      runtime: runtime.name,
      runtimeTarget: route.runtimeTarget,
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
        modelId: runtimeModelId,
        systemPrompt: contextPack.prompt.systemPrompt,
        volatileSystemSuffix: contextPack.prompt.volatileSystemSuffix,
        messages: contextPack.prompt.messages,
        context: { userId },
        signal: runtimeAbort.signal,
        onRunStarted: async (metadata) => {
          timing.providerStartedAt = new Date();
          providerRunMetadata = metadata;
          const metrics = buildTimingMetrics(timing);
          send({ type: "metrics", stage: "provider_started", metrics });
          await db
            .update(runs)
            .set({
              outputs: {
                assistantText,
                lifecycle: "provider_started",
                requestedModelId: modelId,
                modelId: runtimeModelId,
                providerModelId: modelSelection.providerModelId,
                modelSelection,
                runtime: runtime.name,
                runtimeTarget: route.runtimeTarget,
                providerRun: metadata,
                metrics,
              },
              updatedAt: new Date(),
            })
            .where(eq(runs.id, runId));
          await appendInlineRunEvent(db, runId, {
            eventType: "provider_run_started",
            status: "pending",
            label: `Started ${runtime.name} run`,
            metadata: {
              ...(metadata as unknown as Record<string, unknown>),
              runtimeTarget: route.runtimeTarget,
              requestedModelId: modelId,
              runtimeModelId,
              providerModelId: modelSelection.providerModelId,
              modelSelection,
              metrics,
            },
          });
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
        if (signal?.aborted) {
          runtimeAbort.abort();
          break;
        }
        if (ev.type === "text-delta") {
          assistantText += ev.delta;
          send({ type: "text-delta", delta: ev.delta });
          if (!timing.firstTokenAt && ev.delta.length > 0) {
            timing.firstTokenAt = new Date();
            const metrics = buildTimingMetrics(timing);
            send({ type: "metrics", stage: "first_token", metrics });
            await appendInlineRunEvent(db, runId, {
              eventType: "first_token_streamed",
              status: "succeeded",
              label: "First token streamed",
              metadata: {
                runtimeTarget: route.runtimeTarget,
                runtime: runtime.name,
                requestedModelId: modelId,
                runtimeModelId,
                providerModelId: modelSelection.providerModelId,
                modelSelection,
                metrics,
              },
            });
          }
        } else if (ev.type === "provider-reasoning-delta") {
          if (diagnosticStreamEnabled) {
            send({
              type: ev.type,
              iteration: ev.iteration,
              blockIndex: ev.blockIndex,
              delta: ev.delta,
            });
          }
        } else if (ev.type === "provider-reasoning-redacted") {
          if (diagnosticStreamEnabled) {
            send({
              type: ev.type,
              iteration: ev.iteration,
              blockIndex: ev.blockIndex,
            });
          }
        } else if (ev.type === "provider-response-metadata") {
          if (diagnosticStreamEnabled) {
            send({ ...ev });
          }
        } else if (ev.type === "usage") {
          const usage = normalizeRuntimeUsage(ev);
          tokensIn = usage.tokensIn;
          tokensOut = usage.tokensOut;
          inputTokens = usage.inputTokens;
          cacheReadInputTokens = usage.cacheReadInputTokens;
          cacheWriteInputTokens = usage.cacheWriteInputTokens;
        } else if (ev.type === "tool-call") {
          toolEvents.recordCall(ev.call);
          const persistedCall = toolEvents
            .calls()
            .find((call) => call.id === ev.call.id);
          if (persistedCall) {
            await appendToolCallRunEvent({
              db,
              runId: runId,
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
              runId: runId,
              sequence: await nextRunEventSequence(db, runId),
              call: persistedCall,
              result: persistedResult,
            });
          }
          send({ type: "tool-result", result: ev.result });
        } else if (ev.type === "error") {
          const normalized = normalizeRuntimeError(
            ev.message,
            runtimeErrorContext(runtime.name, route, modelSelection),
          );
          runtimeErrors.push(normalized);
          send({ type: "error", message: normalized.userMessage });
        }
      }
    } catch (err) {
      const normalized = normalizeRuntimeError(
        err,
        runtimeErrorContext(runtime.name, route, modelSelection),
      );
      runtimeErrors.push(normalized);
      send({ type: "error", message: normalized.userMessage });
      await appendInlineRunEvent(db, runId, {
        eventType: "provider_run_failed",
        status: "failed",
        label: "Provider run failed",
        error: normalized.userMessage,
        metadata: {
          errorDetails: normalized,
          runtimeTarget: route.runtimeTarget,
          runtime: runtime.name,
          requestedModelId: modelId,
          runtimeModelId,
          providerModelId: modelSelection.providerModelId,
          modelSelection,
          metrics: buildTimingMetrics(timing),
        },
      });
    }

    const runError = signal?.aborted
      ? "Browser request disconnected before the local chat run completed."
      : runtimeErrors.length > 0
        ? runtimeErrors.map((err) => err.userMessage).join("\n")
        : null;
    const completedAt = new Date();
    timing.completedAt = completedAt;
    const finalMetrics = buildTimingMetrics(timing);
    await persistProviderTraceCapture({
      db,
      runId,
      capture: providerTrace.snapshot(completedAt),
    });

    const persistedResult = await persistInlineAssistantResult({
      db,
      runId,
      userId,
      threadId: thread.id,
      userMessageId,
      requestedModelId: modelId,
      modelId: runtimeModelId,
      runtimeName: runtime.name,
      runtimeTarget: route.runtimeTarget,
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
      modelSelection,
      terminalStatus: runError ? "failed" : "succeeded",
      error: runError,
      timingMetrics: finalMetrics,
      suppressedSkillIds:
        activatedSkills?.flatMap((skill) =>
          typeof skill.id === "string" ? [skill.id] : [],
        ) ?? [],
      artifactContextTarget,
      separateFromArtifact,
      appEditSourceOmitted,
      completedAt,
    });

    send({ type: "metrics", stage: "completed", metrics: finalMetrics });
    if (runError) return;

    send({ type: "done" });
    send({
      type: "persisted",
      assistantMessageId: persistedResult.assistantMessageId,
      tokensIn,
      tokensOut,
      artifacts: persistedResult.artifacts,
      appDraftVersions: persistedResult.appDraftVersions,
      recommendations: persistedResult.recommendations,
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
  requestedModelId,
  modelId,
  runtimeName,
  runtimeTarget,
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
  modelSelection,
  terminalStatus,
  error,
  timingMetrics,
  suppressedSkillIds,
  artifactContextTarget,
  separateFromArtifact,
  appEditSourceOmitted,
  completedAt,
}: {
  db: Database;
  runId: string;
  userId: string;
  threadId: string;
  userMessageId: string;
  requestedModelId: string;
  modelId: string;
  runtimeName: string;
  runtimeTarget: ChatRuntimeRoute["runtimeTarget"];
  assistantText: string;
  tokensIn: number;
  tokensOut: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  toolCalls: ReturnType<ReturnType<typeof createToolEventAccumulator>["calls"]>;
  toolResults: ReturnType<ReturnType<typeof createToolEventAccumulator>["results"]>;
  providerRunMetadata: RuntimeRunMetadata | null;
  runtimeErrors: NormalizedRuntimeError[];
  modelSelection: RuntimeModelSelection;
  terminalStatus: InlineTerminalStatus;
  error: string | null;
  timingMetrics: ChatRunTimingMetrics;
  suppressedSkillIds: string[];
  artifactContextTarget?: WorkspaceArtifactVersionTarget | null;
  separateFromArtifact?: WorkspaceArtifactVersionTarget | null;
  appEditSourceOmitted: boolean;
  completedAt: Date;
}): Promise<{
  assistantMessageId: string | undefined;
  artifacts: WorkspaceArtifactSummary[];
  appDraftVersions: AppDraftVersionSummary[];
  recommendations: PersistedRecommendation[];
}> {
  let assistantMessageId: string | undefined;
  let artifacts: WorkspaceArtifactSummary[] = [];
  let appDraftVersions: AppDraftVersionSummary[] = [];
  let recommendations: PersistedRecommendation[] = [];
  const shouldPersistAssistant = shouldPersistAssistantMessage({
    terminalStatus,
    assistantText,
    toolCallsCount: toolCalls.length,
    toolResultsCount: toolResults.length,
  });

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
      runId: runId,
      modelId,
      runtime: runtimeName,
      calls: toolCalls,
      results: toolResults,
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
        runId: runId,
        assistantText,
        targetArtifact: artifactContextTarget,
        separateFromArtifact,
      });
      if (artifacts.length > 0) {
        await appendInlineRunEvent(db, runId, {
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
            await appendInlineRunEvent(db, runId, {
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

  await refreshThreadPresentationMetadata({
    db,
    threadId,
    now: completedAt,
  });

  await db
    .update(runs)
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
        usage: {
          tokensIn,
          tokensOut,
          inputTokens,
          cacheReadInputTokens,
          cacheWriteInputTokens,
        },
        requestedModelId,
        modelId,
        providerModelId: modelSelection.providerModelId,
        modelSelection,
        runtime: runtimeName,
        runtimeTarget,
        ...(providerRunMetadata ? { providerRun: providerRunMetadata } : {}),
        ...(runtimeErrors.length > 0 ? { errorDetails: runtimeErrors } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(appDraftVersions.length > 0 ? { appDraftVersions } : {}),
        ...(recommendations.length > 0 ? { recommendations } : {}),
        metrics: timingMetrics,
      },
      workerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: completedAt,
      completedAt,
      updatedAt: completedAt,
    })
    .where(and(eq(runs.id, runId), ne(runs.status, "canceled")));

  if (terminalStatus === "succeeded" && assistantMessageId) {
    try {
      await enqueueMemoryCapture(db, {
        userId,
        threadId,
        fromMessageId: userMessageId,
        toMessageId: assistantMessageId,
        runId: runId,
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
    metadata: {
      assistantMessageId,
      userMessageId,
      requestedModelId,
      modelId,
      providerModelId: modelSelection.providerModelId,
      modelSelection,
      runtime: runtimeName,
      runtimeTarget,
      usage: {
        tokensIn,
        tokensOut,
        inputTokens,
        cacheReadInputTokens,
        cacheWriteInputTokens,
      },
      ...(runtimeErrors.length > 0 ? { errorDetails: runtimeErrors } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(appDraftVersions.length > 0 ? { appDraftVersions } : {}),
      ...(recommendations.length > 0 ? { recommendations } : {}),
      metrics: timingMetrics,
    },
  });

  return {
    assistantMessageId,
    artifacts,
    appDraftVersions,
    recommendations,
  };
}

async function appendInlineRunEvent(
  db: Database,
  runId: string,
  input: Omit<
    Parameters<typeof appendRunEventWithNextSequence>[0],
    "db" | "runId"
  >,
): Promise<void> {
  try {
    await appendRunEventWithNextSequence({ db, runId, ...input });
  } catch (err) {
    process.stderr.write(
      `[chat-inline-event-error] ${JSON.stringify({
        runId: runId,
        eventType: input.eventType,
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}

async function nextRunEventSequence(
  db: Database,
  runId: string,
): Promise<number> {
  const rows = await db.execute<{ sequence: number }>(
    sql`select coalesce(max(sequence), 0)::int + 1 as sequence from run_events where run_id = ${runId}`,
  );
  return rows[0]?.sequence ?? 1;
}

function resolveRuntimeName(route: ChatRuntimeRoute): RuntimeName {
  if (route.runtimeTarget === "agentcore-worker") return "agentcore";
  const raw = process.env.RUNTIME_V2_DIRECT_RUNTIME?.trim().toLowerCase();
  if (raw === "bedrock") return raw;
  return "bedrock";
}

function runtimeErrorContext(
  runtime: string,
  route: ChatRuntimeRoute,
  modelSelection: RuntimeModelSelection,
) {
  return {
    runtime,
    runtimeTarget: route.runtimeTarget,
    requestedModelId: modelSelection.requestedModelId,
    modelId: modelSelection.modelId,
    ...(modelSelection.providerModelId
      ? { providerModelId: modelSelection.providerModelId }
      : {}),
  };
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

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}
