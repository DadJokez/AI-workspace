import {
  type AgentEvent,
  ToolRegistry,
  isValidModelId,
  runAgentLoop,
} from "@ai-workspace/agent";

import type { AgentRuntime, TurnInput } from "./types";

/**
 * Bedrock-backed implementation of `AgentRuntime`. Thin wrapper over the
 * existing `runAgentLoop` so the rest of the app talks to the same interface
 * regardless of which runtime is selected.
 *
 * Stateless: Bedrock's `converseStream` takes the full message history on
 * every turn. `threadId` is unused here but kept in the contract because the
 * Cursor runtime needs it.
 */
export class BedrockRuntime implements AgentRuntime {
  readonly name = "bedrock" as const;

  private readonly registry: ToolRegistry;

  constructor(opts: { registry?: ToolRegistry } = {}) {
    this.registry = opts.registry ?? new ToolRegistry();
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    if (!isValidModelId(input.modelId)) {
      yield {
        type: "error",
        message: `BedrockRuntime: unknown modelId '${input.modelId}'`,
      };
      return;
    }

    yield* runAgentLoop({
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      registry: this.registry,
      context: input.context,
      signal: input.signal,
    });
  }
}
