import type {
  AgentEvent,
  AgentMessage,
  DiscoveryCatalogEntry,
  ToolContext,
} from "@ai-workspace/agent";

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
      allowedTools?: string[];
      blockedTools?: string[];
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
  /**
   * Dynamic per-turn context (context receipts, recommendation cards). The
   * Bedrock runtime renders it after the prompt-cache checkpoint (#385);
   * runtimes without that seam append it to the system prompt so no context
   * is ever dropped.
   */
  volatileSystemSuffix?: string;
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
   * Built-in, non-account tools to expose for this turn. Keep this empty for
   * fast chat so simple turns do not pay tool-selection overhead.
   */
  builtinTools?: readonly string[];
  /**
   * Force the first model step to call this mounted tool. Runtimes fail closed
   * when it is unavailable, then resume automatic selection after the result.
   */
  requiredToolName?: string;
  /**
   * Progressive tool discovery (#384). When present, runtimes mount only MCP
   * tools whose provider is in `activatedProviders` (first-party and builtin
   * tools always mount); absent = mount everything, today's behavior.
   * `catalog` (P2) additionally mounts the first-party discovery tools —
   * the model can search it and stickily activate provider expansions
   * mid-turn; the web layer persists activations from the tool-call event
   * stream. Parity mode passes every granted provider with no catalog and
   * is byte-identical to absence.
   */
  toolDiscovery?: {
    activatedProviders: readonly string[];
    catalog?: readonly DiscoveryCatalogEntry[];
  };
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
