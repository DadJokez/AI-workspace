import type { AgentEvent, AssistantSource } from "@ai-workspace/agent";

import type { AppDraftVersionSummary } from "@/lib/app-draft-versions";
import type {
  ChatRouteReceipt,
  ChatRuntimeRoute,
} from "@/lib/chat-routing";
import type { ConversationResourceResolution } from "@/lib/conversation-resources";
import type { PersistedRecommendation } from "@/lib/recommendations";
import type { RuntimeModelSelection } from "@/lib/runtime-model-policy";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

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

export type ChatStreamStopReason =
  | "completed"
  | "queued"
  | "runtime_error"
  | "request_aborted"
  | "stream_error";

export type ChatStreamTerminalEvent =
  | {
      type: "done";
      stopReason: Extract<ChatStreamStopReason, "completed" | "queued">;
    }
  | {
      type: "failed";
      stopReason: Exclude<ChatStreamStopReason, "completed" | "queued">;
      message: string;
    };

type RelayedProviderEvent = Extract<
  AgentEvent,
  | { type: "text-delta" }
  | { type: "provider-reasoning-delta" }
  | { type: "provider-reasoning-redacted" }
  | { type: "provider-response-metadata" }
>;

export type ChatStreamEvent =
  | {
      type: "meta";
      threadId: string;
      runId: string;
      userMessageId: string;
      modelId: string;
      modelOverride: boolean;
      executionMode: ChatRuntimeRoute["executionMode"];
      runtimeRoute: ChatRuntimeRoute;
      routeReceipt: ChatRouteReceipt;
      resourceResolution: ConversationResourceResolution;
      replaceMessageId?: string;
    }
  | {
      type: "model";
      requestedModelId: string;
      modelOverride: boolean;
      modelId: string;
      providerModelId?: string;
      modelSelection: RuntimeModelSelection;
      runtime: string;
      runtimeTarget: ChatRuntimeRoute["runtimeTarget"];
    }
  | RelayedProviderEvent
  | {
      type: "tool-call";
      call: PersistedToolCall;
    }
  | {
      type: "tool-result";
      result: PersistedToolResult;
    }
  | {
      type: "usage";
      tokensIn: number;
      tokensOut: number;
    }
  | {
      type: "heartbeat";
      at: string;
    }
  | {
      type: "metrics";
      stage: "provider_started" | "first_token" | "completed";
      metrics: ChatRunTimingMetrics | undefined;
    }
  | {
      type: "queued";
      threadId: string;
      runId: string;
      status: string;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "persisted";
      assistantMessageId: string | undefined;
      /**
       * Present only when the persisted text differs from the streamed
       * deltas (#652: a literal contract reduced a prose-wrapped answer).
       * The client must replace its accumulated content with this value.
       */
      content?: string;
      tokensIn: number;
      tokensOut: number;
      artifacts: WorkspaceArtifactSummary[];
      appDraftVersions: AppDraftVersionSummary[];
      recommendations: PersistedRecommendation[];
      sources: AssistantSource[];
      runId: string;
      threadId: string;
    }
  | ChatStreamTerminalEvent;

export type ChatStreamSend = (event: ChatStreamEvent) => void;

const CHAT_STREAM_EVENT_TYPES: ReadonlySet<ChatStreamEvent["type"]> = new Set([
  "meta",
  "model",
  "text-delta",
  "provider-reasoning-delta",
  "provider-reasoning-redacted",
  "provider-response-metadata",
  "tool-call",
  "tool-result",
  "usage",
  "heartbeat",
  "metrics",
  "queued",
  "error",
  "persisted",
  "done",
  "failed",
]);

export function isChatStreamEventType(
  value: string,
): value is ChatStreamEvent["type"] {
  return CHAT_STREAM_EVENT_TYPES.has(value as ChatStreamEvent["type"]);
}

export function isChatStreamTerminalEvent(
  event: unknown,
): event is ChatStreamTerminalEvent {
  if (typeof event !== "object" || event === null || !("type" in event)) {
    return false;
  }
  const candidate = event as {
    type?: unknown;
    stopReason?: unknown;
    message?: unknown;
  };
  if (candidate.type === "done") {
    return (
      candidate.stopReason === "completed" ||
      candidate.stopReason === "queued"
    );
  }
  return (
    candidate.type === "failed" &&
    (candidate.stopReason === "runtime_error" ||
      candidate.stopReason === "request_aborted" ||
      candidate.stopReason === "stream_error") &&
    typeof candidate.message === "string"
  );
}

export function createChatStreamWriter(
  enqueue: (event: ChatStreamEvent) => void,
) {
  let terminalSent = false;

  return {
    send(event: ChatStreamEvent) {
      if (terminalSent) {
        throw new Error(
          `Chat stream emitted ${event.type} after its terminal event.`,
        );
      }
      enqueue(event);
      if (isChatStreamTerminalEvent(event)) terminalSent = true;
    },
    hasTerminal() {
      return terminalSent;
    },
  };
}

export const CHAT_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

export function startChatStreamHeartbeat(
  send: ChatStreamSend,
  {
    intervalMs = CHAT_STREAM_HEARTBEAT_INTERVAL_MS,
    now = () => new Date(),
  }: {
    intervalMs?: number;
    now?: () => Date;
  } = {},
) {
  const timer = setInterval(() => {
    try {
      send({ type: "heartbeat", at: now().toISOString() });
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
