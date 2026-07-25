import {
  parseAssistantSources,
  type AssistantSource,
} from "@ai-workspace/agent/sources";
import { areUploadsReplayable } from "@/lib/attachment-replay";
import type { AgentActivityEvent } from "@/lib/activity-events";
import type { ChatRuntimeLane } from "@/lib/chat-routing";
import type { LiveReasoningBlock } from "@/lib/run-inspector";
import {
  parseToolName,
  type PersistedToolCall,
  type PersistedToolResult,
} from "@/lib/tool-events";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type {
  PersistedRecommendation,
} from "@/lib/recommendations";
import type { AppDraftVersionSummary } from "@/lib/app-draft-versions";
import type { ModelOption } from "@/components/ModelSelector";
import type { ThreadSummary } from "@/components/Sidebar";
import type { ActivatedSlashSkill } from "@/lib/skill-commands";

export const FALLBACK_DEFAULT_MODEL_ID = "sonnet-4-5";
export const DEFAULT_MODEL_PREFIX = "ai-workspace-default-model:";
export const THREADS_LIMIT = 50;
export const RUN_POLL_INTERVAL_MS = 500;
export const BACKGROUND_COMPLETION_TITLE = "✓ Done — Comparative";

export type RightPane =
  | { kind: "workspace" }
  | { kind: "notifications" }
  | { kind: "artifact"; artifact: WorkspaceArtifactSummary }
  | { kind: "inspector"; runId: string };

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt?: string;
  modelId?: string;
  runtimeLane?: ChatRuntimeLane;
  tokensIn?: number | null;
  tokensOut?: number | null;
  pending?: boolean;
  status?: string;
  livePhase?: string;
  liveTokens?: number;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  artifacts?: WorkspaceArtifactSummary[];
  appDraftVersions?: AppDraftVersionSummary[];
  recommendations?: PersistedRecommendation[];
  activityEvents?: AgentActivityEvent[];
  sources?: AssistantSource[];
  runId?: string;
  runStatus?: string;
  runError?: string | null;
  canCancel?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
  hasAttachments?: boolean;
  attachmentsReplayable?: boolean;
  /** Browser-local filenames shown while the persisted artifact row is loading. */
  attachmentPreviews?: Array<{ name: string; sizeBytes?: number }>;
  persisted?: boolean;
  providerReasoning?: LiveReasoningBlock[];
}

export interface ChatTab {
  id: string;
  title: string;
  threadId?: string;
  restoreDraft?: boolean;
  messages: UiMessage[];
  modelId?: string;
  busy: boolean;
  error?: string;
  loaded: boolean;
}

export interface ModelsResponse {
  defaultModelId: string;
  models: ModelOption[];
  runtimeV2Enabled?: boolean;
}

export interface UserResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: "admin" | "user";
    customInstructions: string | null;
    defaultModelId: string | null;
    assistantName: string | null;
    tourCompletedAt: string | null;
  };
}

export interface ThreadsResponse {
  threads: ThreadSummary[];
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId: string | null;
  runtimeLane?: ChatRuntimeLane;
  runtime: "bedrock" | "agentcore" | string | null;
  toolCalls: PersistedToolCall[] | null;
  toolResults: PersistedToolResult[] | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  artifacts?: WorkspaceArtifactSummary[];
  appDraftVersions?: AppDraftVersionSummary[];
  recommendations?: PersistedRecommendation[];
  activityEvents?: AgentActivityEvent[];
  sources?: AssistantSource[];
  pending?: boolean;
  status?: string;
  runPhase?: string;
  liveTokens?: number;
  runId?: string;
  runStatus?: string;
  runError?: string | null;
  canCancel?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
  createdAt: string;
}

export interface ThreadMessagesResponse {
  messages: ThreadMessage[];
}

export function threadMessageToUiMessage(message: ThreadMessage): UiMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    modelId: message.modelId ?? undefined,
    runtimeLane: message.runtimeLane,
    tokensIn: message.tokensIn,
    tokensOut: message.tokensOut,
    pending: message.pending,
    status: message.status,
    livePhase: message.runPhase,
    liveTokens: message.liveTokens,
    toolCalls: message.toolCalls ?? undefined,
    toolResults: message.toolResults ?? undefined,
    artifacts: message.artifacts,
    appDraftVersions: message.appDraftVersions,
    recommendations: message.recommendations,
    activityEvents: message.activityEvents,
    sources: message.sources,
    runId: message.runId,
    runStatus: message.runStatus,
    runError: message.runError,
    canCancel: message.canCancel,
    canRetry: message.canRetry,
    canResume: message.canResume,
    hasAttachments: message.artifacts?.some(
      (artifact) => artifact.source === "user-upload",
    ),
    attachmentsReplayable: messageUploadsReplayable(message.artifacts),
    persisted: true,
  };
}

export function mergeLoadedMessages(
  loadedMessages: UiMessage[],
  currentMessages: UiMessage[],
): UiMessage[] {
  if (currentMessages.length === 0) return loadedMessages;

  const loadedIds = new Set(loadedMessages.map((message) => message.id));
  const hasSameMessage = (candidate: UiMessage) =>
    loadedMessages.some(
      (message) =>
        message.role === candidate.role &&
        message.content.trim() === candidate.content.trim(),
    );

  const localOnly = currentMessages.filter((message) => {
    if (loadedIds.has(message.id)) return false;
    return !hasSameMessage(message);
  });

  return [...loadedMessages, ...localOnly];
}

export function nextPreviewArtifactAfterPersisted(
  current: WorkspaceArtifactSummary | null,
  persistedArtifacts?: WorkspaceArtifactSummary[],
): WorkspaceArtifactSummary | null {
  if (!current || !persistedArtifacts?.length) return current;

  const nextVersion = persistedArtifacts
    .filter(
      (artifact) =>
        artifact.id !== current.id &&
        artifact.artifactGroupId === current.artifactGroupId,
    )
    .sort((a, b) => b.versionNumber - a.versionNumber)[0];

  return nextVersion ?? current;
}

function messageUploadsReplayable(
  artifacts: WorkspaceArtifactSummary[] | undefined,
): boolean {
  const uploads = (artifacts ?? []).filter(
    (artifact) => artifact.source === "user-upload",
  );
  return areUploadsReplayable(
    uploads.map((artifact) => ({
      mimeType: artifact.mimeType,
      metadata: artifact.metadata ?? null,
    })),
  );
}

export function makeFreshTab(
  modelId?: string,
  restoreDraft = true,
): ChatTab {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    threadId: undefined,
    restoreDraft,
    messages: [],
    modelId,
    busy: false,
    loaded: true,
  };
}

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 32) return trimmed;
  return trimmed.slice(0, 32).trimEnd() + "…";
}

export function deriveSendTitle(
  text: string,
  activatedSkill?: ActivatedSlashSkill,
): string {
  if (!activatedSkill) return deriveTitle(text);
  const args = activatedSkill.args.trim();
  return deriveTitle(
    args ? `${activatedSkill.name}: ${args}` : activatedSkill.name,
  );
}

export function appNameFromRecommendation(
  recommendation: PersistedRecommendation,
): string {
  const filename =
    typeof recommendation.metadata?.filename === "string"
      ? recommendation.metadata.filename
      : "Generated app";
  const stem = filename.replace(/\.[^.]+$/, "");
  const title = stem
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return title || "Generated app";
}

export function formatToolName(raw: string): string {
  const match = /^mcp__([^_]+)__(.+)$/.exec(raw);
  const pretty = match ? `${match[1]} · ${match[2]}` : raw;
  return pretty.length > 48 ? pretty.slice(0, 47) + "…" : pretty;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function streamToolCallToPersisted(
  value: unknown,
): PersistedToolCall | null {
  if (!isPlainRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : crypto.randomUUID();
  const name = typeof value.name === "string" ? value.name : "tool";
  const parsed = parseToolName(name);
  return {
    id,
    name,
    provider: parsed.provider,
    toolName: parsed.toolName,
    input: isPlainRecord(value.input) ? value.input : {},
    startedAt: new Date().toISOString(),
  };
}

export function streamToolResultToPersisted(
  value: unknown,
  calls: readonly PersistedToolCall[],
): PersistedToolResult | null {
  if (!isPlainRecord(value) || typeof value.toolCallId !== "string") {
    return null;
  }
  const call = calls.find((candidate) => candidate.id === value.toolCallId);
  return {
    toolCallId: value.toolCallId,
    ...(call
      ? {
          name: call.name,
          provider: call.provider,
          toolName: call.toolName,
        }
      : {}),
    output: value.output,
    isError: value.isError === true,
    completedAt: new Date().toISOString(),
  };
}

function upsertToolCall(
  calls: PersistedToolCall[] | undefined,
  call: PersistedToolCall,
): PersistedToolCall[] {
  const existing = calls ?? [];
  if (existing.some((candidate) => candidate.id === call.id)) {
    return existing.map((candidate) =>
      candidate.id === call.id ? { ...candidate, ...call } : candidate,
    );
  }
  return [...existing, call];
}

function upsertToolResult(
  results: PersistedToolResult[] | undefined,
  result: PersistedToolResult,
): PersistedToolResult[] {
  const existing = results ?? [];
  if (existing.some((candidate) => candidate.toolCallId === result.toolCallId)) {
    return existing.map((candidate) =>
      candidate.toolCallId === result.toolCallId
        ? { ...candidate, ...result }
        : candidate,
    );
  }
  return [...existing, result];
}

function updateLiveReasoning(
  blocks: LiveReasoningBlock[] | undefined,
  event: {
    iteration: number;
    blockIndex: number;
    delta?: string;
    redacted?: boolean;
  },
): LiveReasoningBlock[] {
  const existing = blocks ?? [];
  const index = existing.findIndex(
    (block) =>
      block.iteration === event.iteration &&
      block.blockIndex === event.blockIndex,
  );
  const current =
    index >= 0
      ? existing[index]!
      : {
          iteration: event.iteration,
          blockIndex: event.blockIndex,
          text: "",
          redacted: false,
        };
  const next = {
    ...current,
    text: current.text + (event.delta ?? ""),
    redacted: current.redacted || event.redacted === true,
  };
  if (index < 0) return [...existing, next];
  return existing.map((block, blockIndex) =>
    blockIndex === index ? next : block,
  );
}

export type AssistantStreamAction =
  | {
      type: "runtime";
      modelId?: string;
      runtimeLane?: ChatRuntimeLane;
      runId?: string;
    }
  | { type: "text-delta"; delta: string }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "provider-started" }
  | {
      type: "reasoning-delta";
      iteration: number;
      blockIndex: number;
      delta: string;
    }
  | {
      type: "reasoning-redacted";
      iteration: number;
      blockIndex: number;
    }
  | { type: "tool-call"; call: PersistedToolCall | null }
  | { type: "tool-result"; result: PersistedToolResult | null }
  | {
      type: "queued";
      status: string;
      modelId?: string;
      runtimeLane?: ChatRuntimeLane;
      runId?: string;
    }
  | {
      type: "persisted";
      messageId?: string;
      /** Replaces streamed content when the persisted text differs (#652). */
      content?: string;
      modelId?: string;
      runtimeLane?: ChatRuntimeLane;
      runId?: string;
      artifacts?: WorkspaceArtifactSummary[];
      appDraftVersions?: AppDraftVersionSummary[];
      recommendations?: PersistedRecommendation[];
      sources?: AssistantSource[];
      tokensIn?: number;
      tokensOut?: number;
    }
  | { type: "complete"; queued: boolean; runId?: string }
  | { type: "abort" | "error" };

export function reduceAssistantStreamMessage(
  message: UiMessage,
  action: AssistantStreamAction,
): UiMessage {
  switch (action.type) {
    case "runtime":
      return {
        ...message,
        modelId: action.modelId,
        runtimeLane: action.runtimeLane,
        runId: action.runId ?? message.runId,
      };
    case "text-delta":
      return {
        ...message,
        content: message.content + action.delta,
        pending: true,
        status: undefined,
        livePhase: "finalizing",
      };
    case "usage":
      return {
        ...message,
        liveTokens: action.tokensIn + action.tokensOut,
      };
    case "provider-started":
      return message.livePhase
        ? message
        : { ...message, livePhase: "planning" };
    case "reasoning-delta":
      return {
        ...message,
        providerReasoning: updateLiveReasoning(message.providerReasoning, {
          iteration: action.iteration,
          blockIndex: action.blockIndex,
          delta: action.delta,
        }),
      };
    case "reasoning-redacted":
      return {
        ...message,
        providerReasoning: updateLiveReasoning(message.providerReasoning, {
          iteration: action.iteration,
          blockIndex: action.blockIndex,
          redacted: true,
        }),
      };
    case "tool-call":
      return {
        ...message,
        status: action.call
          ? `Calling ${formatToolName(action.call.name)}…`
          : "Calling tool…",
        livePhase: "using tools",
        toolCalls: action.call
          ? upsertToolCall(message.toolCalls, action.call)
          : message.toolCalls,
      };
    case "tool-result":
      return {
        ...message,
        status: message.content.length === 0 ? "Working…" : message.status,
        toolResults: action.result
          ? upsertToolResult(message.toolResults, action.result)
          : message.toolResults,
      };
    case "queued":
      return {
        ...message,
        ...(action.runId ? { id: `run:${action.runId}` } : {}),
        pending: true,
        status: action.status,
        modelId: action.modelId,
        runtimeLane: action.runtimeLane,
        runId: action.runId ?? message.runId,
      };
    case "persisted":
      return {
        ...message,
        id: action.messageId ?? message.id,
        content: action.content ?? message.content,
        pending: false,
        status: undefined,
        livePhase: undefined,
        liveTokens: undefined,
        modelId: action.modelId,
        runtimeLane: action.runtimeLane,
        artifacts: action.artifacts,
        appDraftVersions: action.appDraftVersions,
        recommendations: action.recommendations,
        sources: action.sources,
        tokensIn: action.tokensIn,
        tokensOut: action.tokensOut,
        runId: action.runId ?? message.runId,
        runStatus: "succeeded",
        canCancel: false,
        canRetry: false,
        canResume: false,
      };
    case "complete":
      return {
        ...message,
        pending: action.queued,
        status: action.queued ? message.status : undefined,
        ...(action.queued
          ? {}
          : {
              runId: action.runId ?? message.runId,
              runStatus: "succeeded",
              canCancel: false,
              canRetry: false,
              canResume: false,
            }),
      };
    case "abort":
    case "error":
      return { ...message, pending: false, status: undefined };
  }
}

export function parseRuntimeLane(value: unknown): ChatRuntimeLane | undefined {
  return value === "fast-local" ||
    value === "tool-local" ||
    value === "durable-local"
    ? value
    : undefined;
}

export function runtimeLaneLabel(
  lane: ChatRuntimeLane | undefined,
): string | null {
  if (lane === "fast-local") return "Fast";
  if (lane === "tool-local") return "Tools";
  if (lane === "durable-local") return "Durable";
  return null;
}

export function compactModelName(name: string | undefined): string | undefined {
  return name
    ?.replace(/^(Anthropic\s+)?Claude\s+/i, "")
    .replace(/^Amazon\s+/i, "");
}

export function formatChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/network|failed to fetch|load failed|terminated|aborted/i.test(message)) {
    return "Connection lost while receiving updates. The run may have stopped or the browser stream may have dropped; retry to continue.";
  }
  return message;
}

export function parsePersistedSources(value: unknown): AssistantSource[] {
  return parseAssistantSources(value);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

export function providerBooleanMap(
  providers: readonly string[],
): Record<string, boolean> {
  return Object.fromEntries(providers.map((provider) => [provider, true]));
}
