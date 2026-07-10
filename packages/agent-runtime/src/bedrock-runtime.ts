import {
  type AgentEvent,
  type BedrockClient,
  type McpHttpServerSpec,
  type McpToolConnection,
  ToolRegistry,
  connectMcpTools,
  isValidModelId,
  runAgentLoop,
} from "@ai-workspace/agent";
import { createBuiltinTools } from "@ai-workspace/agent/web-fetch-tool";

import type { AgentRuntime, McpServerSpec, TurnInput } from "./types";

/**
 * Bedrock-backed implementation of `AgentRuntime`. Thin wrapper over the
 * existing `runAgentLoop` so the rest of the app talks to the same interface
 * regardless of which runtime is selected.
 *
 * Stateless: Bedrock's `converseStream` takes the full message history on
 * every turn. `threadId` is unused here but kept in the contract because
 * AgentCore uses it for runtime session affinity.
 *
 * Tool support (specs/003 spike): per-turn HTTP MCP servers from
 * `input.mcpServers` are connected via `connectMcpTools` and registered
 * alongside any base tools for the duration of the turn. The Bedrock lane is
 * no longer the tool-less lane.
 */
export class BedrockRuntime implements AgentRuntime {
  readonly name = "bedrock" as const;

  private readonly registry: ToolRegistry;
  private readonly client?: BedrockClient;

  constructor(opts: { registry?: ToolRegistry; client?: BedrockClient } = {}) {
    this.registry = opts.registry ?? new ToolRegistry();
    this.client = opts.client;
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    await input.onRunStarted?.({ runtime: this.name, executionMode: "local" });

    if (!isValidModelId(input.modelId)) {
      yield {
        type: "error",
        message: `BedrockRuntime: unknown modelId '${input.modelId}'`,
      };
      return;
    }

    // Per-turn registry: base tools plus whatever the turn's MCP servers
    // expose. Never mutate the shared base registry.
    const registry = new ToolRegistry();
    registry.registerAll(this.registry.list());
    registry.registerAll(createBuiltinTools(input.builtinTools));

    let mcp: McpToolConnection | null = null;
    const httpServers = pickHttpMcpServers(input.mcpServers);
    if (Object.keys(httpServers).length > 0) {
      try {
        mcp = await connectMcpTools(httpServers);
        for (const tool of mcp.tools) {
          if (!registry.has(tool.name)) registry.register(tool);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield {
          type: "error",
          message: `BedrockRuntime: MCP connection failed — continuing without tools (${message})`,
        };
      }
    }

    try {
      yield* runAgentLoop({
        modelId: input.modelId,
        systemPrompt: composeSystemPrompt(input),
        messages: input.messages,
        registry,
        context: input.context,
        signal: input.signal,
        ...(input.requiredToolName
          ? { requiredToolName: input.requiredToolName }
          : {}),
        ...(this.client ? { client: this.client } : {}),
      });
    } finally {
      await mcp?.close().catch(() => {});
    }
  }
}

function composeSystemPrompt(input: TurnInput): string | undefined {
  const parts = [input.systemPrompt, input.firstTurnPreamble].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Keep only URL-based servers (GitHub MCP et al. speak Streamable HTTP).
 * stdio servers can't run in this process and are skipped.
 */
export function pickHttpMcpServers(
  servers: Record<string, McpServerSpec> | undefined,
): Record<string, McpHttpServerSpec> {
  const out: Record<string, McpHttpServerSpec> = {};
  if (!servers) return out;
  for (const [name, spec] of Object.entries(servers)) {
    if ((spec.type === "http" || spec.type === "sse") && "url" in spec) {
      out[name] = {
        url: spec.url,
        headers: spec.headers,
        allowedTools: spec.allowedTools,
        blockedTools: spec.blockedTools,
      };
    }
  }
  return out;
}
