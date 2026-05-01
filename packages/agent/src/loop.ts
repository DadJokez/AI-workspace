import type { ModelId } from "./models";
import type { ToolRegistry } from "./registry";
import type { AgentEvent, AgentMessage, ToolContext } from "./types";

/**
 * Bedrock-backed agent loop. Streams `AgentEvent`s as the model produces
 * tokens and tool calls. The web layer relays these as SSE.
 *
 * Locked here in PR #3 so consumers compile against a stable signature.
 * Concrete implementation (Bedrock `converseStream` + tool-use orchestration)
 * lands in PR #5 alongside the chat persistence layer.
 */
export interface RunAgentLoopParams {
  modelId: ModelId;
  systemPrompt?: string;
  messages: AgentMessage[];
  /** Tool registry to resolve calls against. Empty registry = no tools. */
  registry: ToolRegistry;
  /** Whitelist of tool names this run is allowed to use. Undefined = all registered tools. */
  allowedTools?: readonly string[];
  /** Hard cap on tool-use round trips per turn. Defaults to 8. */
  maxToolIterations?: number;
  /** Per-output-message token cap. Defaults to the model's `defaultMaxTokens`. */
  maxTokens?: number;
  context: ToolContext;
  /** Aborts the loop. */
  signal?: AbortSignal;
}

// eslint-disable-next-line require-yield
export async function* runAgentLoop(
  _params: RunAgentLoopParams,
): AsyncGenerator<AgentEvent, void, void> {
  throw new Error(
    "runAgentLoop: not yet implemented (lands in PR #5 with chat persistence)",
  );
}

export const DEFAULT_MAX_TOOL_ITERATIONS = 8;
