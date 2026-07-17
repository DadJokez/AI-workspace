/**
 * Progressive tool discovery (#384) — P1 bundle substrate.
 *
 * The unit of dynamism is which providers a conversation has ACTIVATED,
 * never which tools an individual turn mounts (stable bundles, sticky
 * activation — docs/PROGRESSIVE_TOOL_DISCOVERY_SPEC.md). This module is the
 * pure core: given the tools a runtime registered and the conversation's
 * activated provider set, produce the deterministic mounted subset.
 *
 * Static tools (base + builtins) always mount; only tools that arrived from
 * a dynamic (MCP) provider are gated by activation. Output preserves the
 * input's registration order, which is already deterministic
 * (provider-alpha, then tool-alpha), so identical inputs yield identical
 * toolConfig bytes — the cache guarantee the spec is built on.
 */

export interface ToolDiscoveryState {
  /**
   * Providers whose expansions this conversation has activated. Additive and
   * sticky for the life of the conversation — never removed mid-thread, so
   * each activated bundle pays at most one tools-cache write.
   */
  activatedProviders: readonly string[];
}

/**
 * Provider prefix of an MCP-style tool name ("github__list_prs" → "github").
 * Null for names without the `${provider}__${tool}` shape (first-party
 * tools), which are never activation-gated.
 */
export function providerOfToolName(name: string): string | null {
  const idx = name.indexOf("__");
  return idx > 0 ? name.slice(0, idx) : null;
}

/**
 * The provider slug as it appears inside MCP tool names. `mcpToolName`
 * sanitizes `[^a-zA-Z0-9_]` to `_` when composing `${provider}__${tool}`,
 * so a slug like "google-drive" yields tools named `google_drive__*`.
 * Activation sets are keyed by RAW slugs — this normalizer is how the
 * resolver matches the two namespaces, so a multi-word provider can never
 * silently drop its tools under activation.
 */
export function sanitizeProviderKey(provider: string): string {
  return provider.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * The mounted allow-list for one loop iteration. `dynamicToolNames` is the
 * subset of `allToolNames` that came from per-turn MCP connections — static
 * tools always mount. Returns names in `allToolNames` order.
 */
export function resolveMountedToolNames(
  allToolNames: readonly string[],
  dynamicToolNames: ReadonlySet<string>,
  activatedProviders: ReadonlySet<string>,
): string[] {
  const activatedKeys = new Set(
    [...activatedProviders].map(sanitizeProviderKey),
  );
  return allToolNames.filter((name) => {
    if (!dynamicToolNames.has(name)) return true;
    const provider = providerOfToolName(name);
    return provider !== null && activatedKeys.has(provider);
  });
}

/**
 * Canonical serialization of an activation set: deduped, sorted,
 * comma-joined. Doubles as the thread-persistence format
 * (`chat_threads.mcp_signature`) and an order-insensitive equality key.
 */
export function serializeActivation(providers: Iterable<string>): string {
  return Array.from(new Set(providers)).sort().join(",");
}

export function parseActivation(
  serialized: string | null | undefined,
): string[] {
  if (!serialized) return [];
  return Array.from(
    new Set(
      serialized
        .split(",")
        .map((provider) => provider.trim())
        .filter(Boolean),
    ),
  ).sort();
}
