import type { AgentEvent, AgentMessage, ToolContext } from "@ai-workspace/agent";

/**
 * Per-turn MCP server config. The AWS runtime lanes forward HTTP/SSE servers
 * to the shared Bedrock agent loop; stdio servers are retained in the type so
 * callers can reject or ignore them at the runtime boundary.
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

export interface RuntimeRunMetadata {
  /** Runtime implementation that started the provider run. */
  runtime: RuntimeName;
  /** Provider-side agent/session id, when the runtime exposes one. */
  providerAgentId?: string;
  /** Provider-side run id, when the runtime exposes one. */
  providerRunId?: string;
  /** Runtime substrate. Comparative runs agent execution inside AWS. */
  executionMode?: "local";
}

/**
 * Runtime-agnostic turn input. Both runtimes accept this shape; the adapter
 * decides how to map it onto its native call.
 *
 * - `bedrock`: stateless, so the full `messages` history is forwarded to
 *   `converseStream` on every turn.
 * - `agentcore`: the same Bedrock loop, hosted in Amazon Bedrock AgentCore for
 *   durable/background work.
 *
 * Anything that's truly runtime-specific (Bedrock toolConfig) lives behind
 * the runtime, not in this contract.
 */
export interface TurnInput {
  /** Stable per-conversation key. AgentCore uses it for session affinity. */
  threadId: string;
  /** Logical model id (e.g. "sonnet-4-6"). Each runtime maps it internally. */
  modelId: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Bounded chat context. Bedrock and AgentCore consume the supplied context. */
  messages: AgentMessage[];
  /** Per-request context passed to tool handlers (and hooks, when wired). */
  context: ToolContext;
  /** Hook for cancellation from the route layer. */
  signal?: AbortSignal;
  /**
   * Per-turn MCP servers (e.g. user's connected GitHub via OAuth). Bedrock and
   * AgentCore connect the HTTP ones through `connectMcpTools`.
   */
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Steering text for user identity, connected tools, Vault memory, artifact
   * context, and custom instructions. Bedrock and AgentCore fold it into the
   * system prompt.
   */
  firstTurnPreamble?: string;
  /**
   * Called once the provider has accepted the turn and returned provider-side
   * ids. The web layer uses this to make long runs recoverable after the
   * browser stream or hosting request is gone.
   */
  onRunStarted?: (metadata: RuntimeRunMetadata) => void | Promise<void>;
}

/**
 * The single seam every chat surface goes through. `apps/web` should depend
 * on this interface, not on either concrete runtime, so swapping is
 * an env-var flip (`RUNTIME=bedrock|agentcore`).
 *
 * Event shape is intentionally identical to `AgentEvent` from the existing
 * Bedrock loop, so the SSE relay in `/api/chat/route.ts` is unchanged when
 * we wire this in.
 */
export interface AgentRuntime {
  /** Stable identifier — useful for logs, telemetry, the model selector tooltip. */
  readonly name: "bedrock" | "agentcore";

  /**
   * Run a single chat turn. Yields `AgentEvent`s as they happen — the web
   * layer relays them as SSE without caring which runtime produced them.
   */
  runTurn(input: TurnInput): AsyncIterable<AgentEvent>;
}

/** Env-derived runtime selection. */
export type RuntimeName = "bedrock" | "agentcore";
