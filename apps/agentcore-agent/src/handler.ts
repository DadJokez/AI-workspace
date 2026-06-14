import {
  type AgentEvent,
  type AgentMessage,
  type BedrockClient,
  type McpHttpServerSpec,
  type McpToolConnection,
  ToolRegistry,
  connectMcpTools,
  isValidModelId,
  runAgentLoop,
} from "@ai-workspace/agent";

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
  messages: AgentMessage[];
  mcpServers?: Record<string, McpHttpServerSpec>;
  userId?: string;
  maxToolIterations?: number;
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
        const s = spec as { url: string; headers?: Record<string, string> };
        mcpServers[name] = { url: s.url, headers: s.headers };
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
    messages: body.messages as AgentMessage[],
    mcpServers,
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
  opts: { signal?: AbortSignal; client?: BedrockClient } = {},
): Promise<void> {
  const registry = new ToolRegistry();
  let mcp: McpToolConnection | null = null;

  const servers = payload.mcpServers ?? {};
  if (Object.keys(servers).length > 0) {
    try {
      mcp = await connectMcpTools(servers, {
        clientName: "ai-hub-agentcore-agent",
      });
      for (const tool of mcp.tools) {
        if (!registry.has(tool.name)) registry.register(tool);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit({
        type: "error",
        message: `MCP connection failed — continuing without tools (${message})`,
      });
    }
  }

  const systemParts = [payload.systemPrompt, payload.firstTurnPreamble].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );

  try {
    for await (const event of runAgentLoop({
      // parseInvocationPayload validated this; the cast narrows for the loop.
      modelId: payload.modelId as Parameters<
        typeof runAgentLoop
      >[0]["modelId"],
      systemPrompt:
        systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      messages: payload.messages,
      registry,
      context: { userId: payload.userId ?? "agentcore" },
      signal: opts.signal,
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

/** Serialize one AgentEvent as an SSE frame. */
export function toSseFrame(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
