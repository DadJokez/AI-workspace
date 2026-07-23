import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONSchema7 } from "json-schema";
import type { Tool } from "./types";

/**
 * MCP-backed tools for the Bedrock agent loop.
 *
 * Per-turn remote MCP servers — `{url, headers}` specs supplied by the app
 * shell — are connected over Streamable HTTP, their tools are
 * listed, and each one is wrapped as a standard `Tool` whose handler proxies
 * `callTool`. The result plugs into the existing `ToolRegistry`/`runAgentLoop`
 * machinery unchanged, which is exactly what the registry's design notes
 * anticipated ("same shape will work for an out-of-process MCP-backed
 * registry later").
 *
 * Auth: per-user bearer headers ride `requestInit.headers` on the transport
 * as short-lived per-turn tokens.
 */

export interface McpHttpServerSpec {
  url: string;
  headers?: Record<string, string>;
  /**
   * Provider-native MCP tool names that may be exposed to the model. Omit to
   * expose every listed tool; pass an empty list to expose none.
   */
  allowedTools?: string[];
  /** Provider-native MCP tool names that must not be exposed. */
  blockedTools?: string[];
  /** Provider-native tool name -> trusted first-result usage guidance. */
  usageNotesByTool?: Record<string, string>;
}

export interface McpToolConnection {
  /** Tools ready to register; names are `${provider}__${tool}`. */
  tools: Tool[];
  /** Providers that connected and the tool count each contributed. */
  providers: Record<string, number>;
  /** Close all underlying MCP clients. Always call after the turn. */
  close(): Promise<void>;
}

const TOOL_NAME_UNSAFE = /[^a-zA-Z0-9_]/g;

/**
 * Bedrock `toolSpec.name` allows `[a-zA-Z0-9_-]+`; we prefix with the
 * provider so tools from different servers can never collide and audit rows
 * stay attributable (`github__list_pull_requests`).
 */
export function mcpToolName(provider: string, toolName: string): string {
  const p = provider.replace(TOOL_NAME_UNSAFE, "_");
  const t = toolName.replace(TOOL_NAME_UNSAFE, "_");
  return `${p}__${t}`.slice(0, 64);
}

/**
 * Connect to each MCP server, list its tools, and wrap them as `Tool`s.
 * Connection failures throw — callers decide whether a turn proceeds
 * tool-less (chat) or fails loudly (skills declared the provider).
 */
export async function connectMcpTools(
  servers: Record<string, McpHttpServerSpec>,
  opts: { clientName?: string } = {},
): Promise<McpToolConnection> {
  const serverEntries = Object.entries(servers).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const settled = await Promise.allSettled(
    serverEntries.map(([provider, spec]) =>
      connectMcpProvider(provider, spec, opts.clientName),
    ),
  );
  const connected = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    await closeAll(connected.map((item) => item.client)).catch(() => {});
    throw failure.reason;
  }

  const clients = connected.map((item) => item.client);
  const tools: Tool[] = [];
  const providers: Record<string, number> = {};
  const seenNames = new Set<string>();

  for (const item of connected) {
    let count = 0;
    for (const tool of item.tools) {
      if (seenNames.has(tool.name)) continue;
      seenNames.add(tool.name);
      count += 1;
      tools.push(tool);
    }
    providers[item.provider] = count;
  }

  return {
    tools,
    providers,
    close: () => closeAll(clients),
  };
}

async function connectMcpProvider(
  provider: string,
  spec: McpHttpServerSpec,
  clientName?: string,
): Promise<{ provider: string; client: Client; tools: Tool[] }> {
  const client = new Client({
    name: clientName ?? "ai-hub-bedrock-agent",
    version: "1.0.0",
  });
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(spec.url),
      spec.headers ? { requestInit: { headers: spec.headers } } : undefined,
    );
    await client.connect(transport);

    const listed = await client.listTools();
    const allowedTools = spec.allowedTools
      ? new Set(spec.allowedTools)
      : null;
    const blockedTools = spec.blockedTools ? new Set(spec.blockedTools) : null;
    const tools = [...listed.tools]
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((tool): Tool[] => {
        if (blockedTools?.has(tool.name)) return [];
        if (allowedTools && !allowedTools.has(tool.name)) return [];
        const remoteName = tool.name;
        const blockedFailedInputs = new Set<string>();
        return [
          {
            name: mcpToolName(provider, remoteName),
            description: tool.description ?? `${provider} tool ${remoteName}`,
            inputSchema: (tool.inputSchema ?? { type: "object" }) as JSONSchema7,
            usageNotes: spec.usageNotesByTool?.[remoteName]?.trim() || undefined,
            // #497: MCP results are third-party content — the loop nonce-frames
            // the serialized output as DATA before the model sees it. Set here,
            // at the client seam, so every current and future server inherits it.
            untrustedOutput: true,
            handler: async (input) => {
              const inputFingerprint = toolInputFingerprint(input);
              if (blockedFailedInputs.has(inputFingerprint)) {
                throw new Error(
                  `MCP tool ${remoteName} blocked an identical retry after a deterministic validation error. Change the arguments using the previous recovery guidance before retrying.`,
                );
              }
              const result = await client.callTool({
                name: remoteName,
                arguments: (input ?? {}) as Record<string, unknown>,
              });
              const text = flattenMcpContent(result.content);
              if (result.isError) {
                if (requiresChangedArguments(result._meta)) {
                  blockedFailedInputs.add(inputFingerprint);
                }
                throw new Error(text || `MCP tool ${remoteName} failed.`);
              }
              return result.structuredContent ?? text;
            },
          },
        ];
      });
    return { provider, client, tools };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

function requiresChangedArguments(meta: unknown): boolean {
  return (
    isRecord(meta) &&
    meta["comparative/retryPolicy"] === "arguments_must_change"
  );
}

function toolInputFingerprint(input: unknown): string {
  return JSON.stringify(canonicalJson(input ?? {}));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenMcpContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "type" in item) {
      const block = item as { type: string; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
    }
    try {
      parts.push(JSON.stringify(item));
    } catch {
      parts.push(String(item));
    }
  }
  return parts.join("\n");
}

async function closeAll(clients: Client[]): Promise<void> {
  await Promise.allSettled(clients.map((c) => c.close()));
}
