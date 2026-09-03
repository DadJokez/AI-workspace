import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONSchema7 } from "json-schema";
import type { Tool, ToolRuntimePolicy } from "./types";

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
  /** Provider-native tool name -> deterministic runtime execution policy. */
  toolPolicies?: Record<string, ToolRuntimePolicy>;
  /** Cautious fallback for tools added after the trusted catalog snapshot. */
  defaultToolPolicy?: ToolRuntimePolicy;
  /** Provider-native tool name -> trusted first-result usage guidance. */
  usageNotesByTool?: Record<string, string>;
  /**
   * Canonical user-visible integration name (the Settings → Integrations card
   * label, e.g. "Google Mail & Calendar"). Used verbatim in degraded-provider
   * prompt guidance so the model's reconnect copy matches the visible UI
   * (#649). Falls back to the provider key when absent.
   */
  displayName?: string;
}

/** One provider that failed to connect or list tools this turn (#713). */
export interface McpProviderFailure {
  provider: string;
  /** `spec.displayName` when supplied, else the provider key. */
  displayName: string;
  /**
   * Underlying connect/list error, for logs, receipts, and error events.
   * Never rendered into the model prompt — a provider-controlled error
   * string is third-party content, not instructions.
   */
  message: string;
}

export interface McpToolConnection {
  /** Tools ready to register; names are `${provider}__${tool}`. */
  tools: Tool[];
  /** Providers that connected and the tool count each contributed. */
  providers: Record<string, number>;
  /**
   * Providers that failed to connect this turn (#713). Healthy providers
   * mount regardless; callers surface these as degraded provider status.
   */
  failedProviders: McpProviderFailure[];
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
 *
 * Mounting is fault-isolated per provider (#713): one dead provider (expired
 * OAuth grant, provider API down) must never blank the tools of the healthy
 * ones for the turn. A provider that fails to connect or list is skipped and
 * reported in `failedProviders`; callers surface the degraded status honestly
 * and the turn proceeds with whatever mounted. A skill that hard-requires a
 * failed provider still fails closed via the loop's `requiredToolName` check.
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
  const failedProviders: McpProviderFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const [provider, spec] = serverEntries[index]!;
    failedProviders.push({
      provider,
      displayName: spec.displayName?.trim() || provider,
      message:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    });
  });

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
    failedProviders,
    close: () => closeAll(clients),
  };
}

/**
 * Honest prompt guidance for providers that failed to mount this turn (#713).
 * Rendered post-cache-checkpoint (volatile suffix / per-turn system text) by
 * the runtimes, so a transient failure never breaks prompt-prefix caching.
 *
 * The say-exactly sentence and the "Settings → Integrations" path mirror the
 * reconnect copy in `apps/web/lib/agent-preamble.ts` /
 * `apps/web/lib/settings-navigation.ts` (#649) — the dependency direction
 * prevents importing them here, so keep the wording in sync with that file.
 * Raw connection errors are deliberately NOT rendered: a provider-controlled
 * error string is untrusted content and stays in logs/receipts only.
 */
export function renderMcpMountFailureGuidance(
  failures: readonly McpProviderFailure[],
): string {
  const names = failures.map((failure) => failure.displayName).join(" and ");
  return [
    "Connected account tools that failed to connect for this turn:",
    ...failures.map((failure) => `- ${failure.displayName}`),
    `These integrations are connected to the user's account, but their tool connection could not be established this turn, so none of their tools are callable right now. The other mounted tools are unaffected — keep using them normally. If the user asks for one of the failed integrations, say plainly that its connection failed this turn and that "${names} needs to be reconnected in Settings → Integrations before I can use it." Do not say all tools are down, do not deny that the account connection exists, and do not invent a result from an integration that did not mount.`,
  ].join("\n");
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
            policy:
              spec.toolPolicies?.[remoteName] ?? spec.defaultToolPolicy,
            executionIdentity: {
              kind: "mcp",
              provider,
              endpoint: spec.url,
              nativeToolName: remoteName,
            },
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
