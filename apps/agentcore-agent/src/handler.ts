import {
  type AgentEvent,
  type AgentMessage,
  type BedrockClient,
  type McpHttpServerSpec,
  type McpToolConnection,
  ToolRegistry,
  connectMcpTools,
  createDiscoveryTools,
  isValidModelId,
  normalizeUserTimeZone,
  renderMcpMountFailureGuidance,
  resolveMountedToolNames,
  runAgentLoop,
  type DiscoveryCatalogEntry,
} from "@ai-workspace/agent";
import { createBuiltinTools } from "@ai-workspace/agent/web-fetch-tool";
import {
  WEB_EGRESS_POLICY_NAME,
  type WebEgressPolicy,
} from "@ai-workspace/agent/web-egress-policy";
import type { WebSearchOptions } from "@ai-workspace/agent/web-search-tool";

/**
 * The invocation contract between `AgentCoreRuntime` (the seam adapter in
 * packages/agent-runtime) and this container. One invocation = one chat
 * turn; the response is an SSE stream of `AgentEvent`s — the same event
 * vocabulary every other runtime emits, so the web layer never knows the
 * loop ran remotely.
 */
export interface InvocationPayload {
  threadId?: string;
  modelId: string;
  systemPrompt?: string;
  firstTurnPreamble?: string;
  /** Validated IANA zone for the clock statement (#432); invalid → absent. */
  userTimeZone?: string;
  messages: AgentMessage[];
  mcpServers?: Record<string, McpHttpServerSpec>;
  builtinTools?: string[];
  webEgressPolicy?: WebEgressPolicy;
  requiredToolName?: string;
  toolDiscovery?: {
    activatedProviders: string[];
    catalog?: DiscoveryCatalogEntry[];
  };
  userId?: string;
  maxToolIterations?: number;
}

function parseToolDiscovery(
  raw: unknown,
): InvocationPayload["toolDiscovery"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const providers = (raw as { activatedProviders?: unknown })
    .activatedProviders;
  if (!Array.isArray(providers)) return undefined;
  const catalogRaw = (raw as { catalog?: unknown }).catalog;
  const catalog = Array.isArray(catalogRaw)
    ? catalogRaw.filter(
        (entry): entry is DiscoveryCatalogEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { provider?: unknown }).provider === "string" &&
          typeof (entry as { tool?: unknown }).tool === "string" &&
          typeof (entry as { description?: unknown }).description ===
            "string" &&
          typeof (entry as { category?: unknown }).category === "string" &&
          ["read", "write", "admin"].includes(
            (entry as { action?: unknown }).action as string,
          ),
      )
    : undefined;
  return {
    activatedProviders: providers.filter(
      (provider): provider is string => typeof provider === "string",
    ),
    ...(catalog?.length ? { catalog } : {}),
  };
}

function parseWebEgressPolicy(raw: unknown): WebEgressPolicy | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const policy = raw as Record<string, unknown>;
  if (
    policy.name !== WEB_EGRESS_POLICY_NAME ||
    !Array.isArray(policy.deniedDomains)
  ) {
    return undefined;
  }
  return {
    name: WEB_EGRESS_POLICY_NAME,
    deniedDomains: policy.deniedDomains.filter(
      (domain): domain is string => typeof domain === "string",
    ),
  };
}

export function parseInvocationPayload(raw: unknown): InvocationPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invocation payload must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  if (!isValidModelId(modelId)) {
    throw new Error(`Unknown or missing modelId '${modelId}'.`);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("Invocation payload must include a non-empty messages array.");
  }

  const mcpServers: Record<string, McpHttpServerSpec> = {};
  if (
    typeof body.mcpServers === "object" &&
    body.mcpServers !== null &&
    !Array.isArray(body.mcpServers)
  ) {
    for (const [name, spec] of Object.entries(
      body.mcpServers as Record<string, unknown>,
    )) {
      if (
        typeof spec === "object" &&
        spec !== null &&
        typeof (spec as { url?: unknown }).url === "string"
      ) {
        const s = spec as {
          url: string;
          headers?: Record<string, string>;
          allowedTools?: unknown;
          blockedTools?: unknown;
          toolPolicies?: unknown;
          defaultToolPolicy?: unknown;
          usageNotesByTool?: unknown;
          displayName?: unknown;
        };
        mcpServers[name] = {
          url: s.url,
          headers: s.headers,
          allowedTools: Array.isArray(s.allowedTools)
            ? s.allowedTools.filter(
                (tool): tool is string => typeof tool === "string",
              )
            : undefined,
          blockedTools: Array.isArray(s.blockedTools)
            ? s.blockedTools.filter(
                (tool): tool is string => typeof tool === "string",
              )
            : undefined,
          toolPolicies: parseToolPolicies(s.toolPolicies),
          defaultToolPolicy: parseToolPolicy(s.defaultToolPolicy),
          usageNotesByTool: parseUsageNotesByTool(s.usageNotesByTool),
          displayName:
            typeof s.displayName === "string" && s.displayName.trim()
              ? s.displayName
              : undefined,
        };
      }
    }
  }

  return {
    threadId: typeof body.threadId === "string" ? body.threadId : undefined,
    modelId,
    systemPrompt:
      typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
    firstTurnPreamble:
      typeof body.firstTurnPreamble === "string"
        ? body.firstTurnPreamble
        : undefined,
    // Re-validated at this trust boundary (#432): the payload crosses the
    // wire, and an invalid zone must degrade to UTC-only, never reach the
    // prompt or throw inside the loop.
    userTimeZone: normalizeUserTimeZone(body.userTimeZone),
    messages: body.messages as AgentMessage[],
    mcpServers,
    builtinTools: Array.isArray(body.builtinTools)
      ? body.builtinTools.filter((tool): tool is string => typeof tool === "string")
      : undefined,
    webEgressPolicy: parseWebEgressPolicy(body.webEgressPolicy),
    requiredToolName:
      typeof body.requiredToolName === "string"
        ? body.requiredToolName
        : undefined,
    toolDiscovery: parseToolDiscovery(body.toolDiscovery),
    userId: typeof body.userId === "string" ? body.userId : undefined,
    maxToolIterations:
      typeof body.maxToolIterations === "number"
        ? body.maxToolIterations
        : undefined,
  };
}

/**
 * Run one turn: connect the payload's MCP servers (per-user bearer headers
 * included), run the shared Bedrock agent loop, emit every event, always
 * close the MCP clients. Identical semantics to `BedrockRuntime.runTurn` —
 * deliberately, since this container is that runtime relocated into
 * AgentCore's session-isolated sandbox.
 */
export async function runInvocation(
  payload: InvocationPayload,
  emit: (event: AgentEvent) => void | Promise<void>,
  opts: {
    signal?: AbortSignal;
    client?: BedrockClient;
    webSearch?: WebSearchOptions;
  } = {},
): Promise<void> {
  const registry = new ToolRegistry();
  registry.registerAll(
    createBuiltinTools(payload.builtinTools, {
      webSearch: opts.webSearch,
      webEgressPolicy: payload.webEgressPolicy,
    }),
  );
  // #384 P2: discovery surface + shared activated set — an activation
  // mid-turn mounts the expansion on the next loop iteration, and the web
  // layer persists it from the streamed tool-call event.
  const discovery = payload.toolDiscovery;
  const activated = discovery ? new Set(discovery.activatedProviders) : null;
  if (discovery?.catalog && activated) {
    registry.registerAll(
      createDiscoveryTools({
        catalog: discovery.catalog,
        activatedProviders: activated,
      }),
    );
  }
  // #713: fault-isolated mounting, same semantics as `BedrockRuntime.runTurn`
  // — healthy providers mount, each failed provider becomes a degraded
  // (non-fatal) error event, and the model is told honestly. This lane has no
  // volatile-suffix seam, so the guidance rides the end of the system prompt.
  let mcp: McpToolConnection | null = null;
  const dynamicToolNames = new Set<string>();
  let mountFailureGuidance: string | undefined;

  const servers = payload.mcpServers ?? {};
  if (Object.keys(servers).length > 0) {
    mcp = await connectMcpTools(servers, {
      clientName: "ai-hub-agentcore-agent",
    });
    for (const tool of mcp.tools) {
      if (!registry.has(tool.name)) {
        registry.register(tool);
        dynamicToolNames.add(tool.name);
      }
    }
    for (const failure of mcp.failedProviders) {
      await emit({
        type: "error",
        degradedProvider: failure.provider,
        message: `MCP connection failed for ${failure.provider} — continuing without its tools (${failure.message})`,
      });
    }
    if (mcp.failedProviders.length > 0) {
      mountFailureGuidance = renderMcpMountFailureGuidance(
        mcp.failedProviders,
      );
    }
  }

  const systemParts = [
    payload.systemPrompt,
    payload.firstTurnPreamble,
    mountFailureGuidance,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  try {
    for await (const event of runAgentLoop({
      // parseInvocationPayload validated this; the cast narrows for the loop.
      modelId: payload.modelId as Parameters<
        typeof runAgentLoop
      >[0]["modelId"],
      systemPrompt:
        systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      ...(payload.userTimeZone
        ? { userTimeZone: payload.userTimeZone }
        : {}),
      messages: payload.messages,
      registry,
      context: { userId: payload.userId ?? "agentcore" },
      signal: opts.signal,
      ...(payload.requiredToolName
        ? { requiredToolName: payload.requiredToolName }
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
      ...(payload.maxToolIterations
        ? { maxToolIterations: payload.maxToolIterations }
        : {}),
      ...(opts.client ? { client: opts.client } : {}),
    })) {
      await emit(event);
    }
  } finally {
    await mcp?.close().catch(() => {});
  }
}

function parseUsageNotesByTool(
  raw: unknown,
): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].trim().length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseToolPolicy(
  raw: unknown,
): "always_allow" | "needs_approval" | "blocked" | undefined {
  return raw === "always_allow" ||
    raw === "needs_approval" ||
    raw === "blocked"
    ? raw
    : undefined;
}

function parseToolPolicies(
  raw: unknown,
): McpHttpServerSpec["toolPolicies"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const entries = Object.entries(raw).flatMap(([toolName, policy]) => {
    const parsed = parseToolPolicy(policy);
    return parsed ? [[toolName, parsed] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Serialize one AgentEvent as an SSE frame. */
export function toSseFrame(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
