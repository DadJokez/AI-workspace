import type { AgentEvent, AgentMessage, ToolContext } from "@ai-workspace/agent";

/**
 * Per-turn MCP server config. Structurally mirrors `@cursor/sdk`'s
 * `McpServerConfig` so this contract stays SDK-agnostic; the Cursor adapter
 * casts directly. Bedrock ignores it.
 */
export type McpServerSpec =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

/**
 * Runtime-agnostic turn input. Both runtimes accept this shape; the adapter
 * decides how to map it onto its native call.
 *
 * - `bedrock`: stateless, so the full `messages` history is forwarded to
 *   `converseStream` on every turn.
 * - `cursor`: fresh-agent-per-turn today. The runtime sends a bounded context
 *   pack assembled by the shell, because AI Hub owns product memory in
 *   Postgres and does not depend on Cursor agent state for continuity.
 *
 * Anything that's truly runtime-specific (Bedrock toolConfig) lives behind
 * the runtime, not in this contract.
 */
export interface TurnInput {
  /** Stable per-conversation key. For Cursor this maps to an `agentId`. */
  threadId: string;
  /** Logical model id (e.g. "sonnet-4-6"). Each runtime maps it internally. */
  modelId: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Bounded chat context. Bedrock consumes all; Cursor packs it into one turn. */
  messages: AgentMessage[];
  /** Per-request context passed to tool handlers (and hooks, when wired). */
  context: ToolContext;
  /** Hook for cancellation from the route layer. */
  signal?: AbortSignal;
  /**
   * Per-turn MCP servers (e.g. user's connected GitHub via OAuth). Cursor
   * forwards them to the fresh agent/send path for this turn. Bedrock ignores.
   */
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Steering text prepended to the first user message of a thread. The Cursor
   * SDK has no system-prompt option on `Agent.create`, so this is how the
   * route educates the model about user identity, connected tools, and custom
   * instructions without repeating that preamble on every turn. Bedrock
   * ignores.
   */
  firstTurnPreamble?: string;
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
