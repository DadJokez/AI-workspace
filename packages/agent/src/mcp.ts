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
  const clients: Client[] = [];
  const tools: Tool[] = [];
  const providers: Record<string, number> = {};
  const seenNames = new Set<string>();

  try {
    for (const [provider, spec] of Object.entries(servers)) {
      const client = new Client({
        name: opts.clientName ?? "ai-hub-bedrock-agent",
        version: "1.0.0",
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(spec.url),
        spec.headers ? { requestInit: { headers: spec.headers } } : undefined,
      );
      await client.connect(transport);
      clients.push(client);

      const listed = await client.listTools();
      let count = 0;
      for (const t of listed.tools) {
        const name = mcpToolName(provider, t.name);
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        count += 1;
        const remoteName = t.name;
        tools.push({
          name,
          description: t.description ?? `${provider} tool ${remoteName}`,
          inputSchema: (t.inputSchema ?? { type: "object" }) as JSONSchema7,
          handler: async (input) => {
            const result = await client.callTool({
              name: remoteName,
              arguments: (input ?? {}) as Record<string, unknown>,
            });
            const text = flattenMcpContent(result.content);
            if (result.isError) {
              throw new Error(text || `MCP tool ${remoteName} failed.`);
            }
            return result.structuredContent ?? text;
          },
        });
      }
      providers[provider] = count;
    }

    return {
      tools,
      providers,
      close: () => closeAll(clients),
    };
  } catch (err) {
    await closeAll(clients).catch(() => {});
    throw err;
  }
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
