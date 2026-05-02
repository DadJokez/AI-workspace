import type { AgentEvent, AgentMessage, ToolContext } from "@ai-workspace/agent";

/**
 * Runtime-agnostic turn input. Both runtimes accept this shape; the adapter
 * decides how to map it onto its native call.
 *
 * - `bedrock`: stateless, so the full `messages` history is forwarded to
 *   `converseStream` on every turn.
 * - `cursor`: durable agents own their own state. The runtime resolves an
 *   `SDKAgent` keyed on `threadId` (creating one on first turn) and only the
 *   newest user message is forwarded via `agent.send()`.
 *
 * Anything that's truly runtime-specific (Bedrock toolConfig, Cursor MCP
 * server config) lives behind the runtime, not in this contract.
 */
export interface TurnInput {
  /** Stable per-conversation key. For Cursor this maps to an `agentId`. */
  threadId: string;
  /** Logical model id (e.g. "sonnet-4-6"). Each runtime maps it internally. */
  modelId: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Full chat history. Bedrock consumes all; Cursor reads only the newest user turn. */
  messages: AgentMessage[];
  /** Per-request context passed to tool handlers (and hooks, when wired). */
  context: ToolContext;
  /** Hook for cancellation from the route layer. */
  signal?: AbortSignal;
}

/**
 * The single seam every chat surface goes through. `apps/web` should depend
 * on this interface, not on either concrete runtime, so swapping is
 * literally an env-var flip (`RUNTIME=cursor|bedrock`).
 *
 * Event shape is intentionally identical to `AgentEvent` from the existing
 * Bedrock loop, so the SSE relay in `/api/chat/route.ts` is unchanged when
 * we wire this in.
 */
export interface AgentRuntime {
  /** Stable identifier — useful for logs, telemetry, the model selector tooltip. */
  readonly name: "bedrock" | "cursor";

  /**
   * Run a single chat turn. Yields `AgentEvent`s as they happen — the web
   * layer relays them as SSE without caring which runtime produced them.
   */
  runTurn(input: TurnInput): AsyncIterable<AgentEvent>;
}

/** Env-derived runtime selection. */
export type RuntimeName = "bedrock" | "cursor";
