import {
  type AgentEvent,
  type BedrockClient,
  type McpHttpServerSpec,
  type McpToolConnection,
  ToolRegistry,
  connectMcpTools,
  createDiscoveryTools,
  isValidModelId,
  renderMcpMountFailureGuidance,
  resolveMountedToolNames,
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
    registry.registerAll(
      createBuiltinTools(input.builtinTools, {
        webEgressPolicy: input.webEgressPolicy,
      }),
    );

    // #384 P2: the discovery surface is part of the core bundle. The
    // activated set is SHARED between these handlers and the resolver
    // below, so an activation mid-turn mounts the expansion on the next
    // loop iteration.
    const discovery = input.toolDiscovery;
    const activated = discovery
      ? new Set(discovery.activatedProviders)
      : null;
    if (discovery?.catalog && activated) {
      registry.registerAll(
        createDiscoveryTools({
          catalog: discovery.catalog,
          activatedProviders: activated,
        }),
      );
    }

    // #713: mounting is fault-isolated per provider. Healthy providers mount
    // and the turn proceeds; each failed provider is reported as a degraded
    // (non-fatal) error event for logs/receipts, and the model is told
    // honestly via post-checkpoint system text so it can point the user at
    // the reconnect path while still using the tools that did mount.
    let mcp: McpToolConnection | null = null;
    const dynamicToolNames = new Set<string>();
    let mountFailureGuidance: string | undefined;
    const httpServers = pickHttpMcpServers(input.mcpServers);
    if (Object.keys(httpServers).length > 0) {
      mcp = await connectMcpTools(httpServers);
      for (const tool of mcp.tools) {
        if (!registry.has(tool.name)) {
          registry.register(tool);
          dynamicToolNames.add(tool.name);
        }
      }
      for (const failure of mcp.failedProviders) {
        yield {
          type: "error",
          degradedProvider: failure.provider,
          message: `BedrockRuntime: MCP connection failed for ${failure.provider} — continuing without its tools (${failure.message})`,
        };
      }
      if (mcp.failedProviders.length > 0) {
        mountFailureGuidance = renderMcpMountFailureGuidance(
          mcp.failedProviders,
        );
      }
    }
    const volatileSystemSuffix = [
      input.volatileSystemSuffix,
      mountFailureGuidance,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");

    try {
      yield* runAgentLoop({
        modelId: input.modelId,
        systemPrompt: composeSystemPrompt(input),
        ...(volatileSystemSuffix ? { volatileSystemSuffix } : {}),
        ...(input.userTimeZone ? { userTimeZone: input.userTimeZone } : {}),
        messages: input.messages,
        registry,
        context: input.context,
        signal: input.signal,
        ...(input.requiredToolName
          ? { requiredToolName: input.requiredToolName }
          : {}),
        ...(activated
          ? {
              resolveAllowedTools: () =>
                resolveMountedToolNames(
                  registry.list().map((tool) => tool.name),
                  dynamicToolNames,
                  activated,
                ),
            }
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
        usageNotesByTool: spec.usageNotesByTool,
        displayName: spec.displayName,
      };
    }
  }
  return out;
}
