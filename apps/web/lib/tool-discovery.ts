import {
  toolsCatalog,
  type ChatThread,
  type Database,
} from "@ai-workspace/db";
import { inArray } from "drizzle-orm";
import {
  parseActivation,
  type DiscoveryCatalogEntry,
} from "@ai-workspace/agent";
import type { ToolDiscoveryMode } from "@/lib/chat-routing";
import { ensureThreadActivation } from "@/lib/thread-activation";

/**
 * Progressive tool discovery, web side (#384 P2).
 *
 * The core bundle keeps conversations under the tool-selection knee: the
 * lightest high-frequency providers mount by default; heavy expansions
 * (github: 44 schemas, notion) stay behind discovery until the model
 * activates them. Membership here is a deliberate constant — revisit with
 * the P4 measurements, not ad hoc.
 */
export const CORE_MCP_PROVIDERS = ["google", "salesforce"] as const;

export interface TurnToolDiscovery {
  activatedProviders: string[];
  catalog?: DiscoveryCatalogEntry[];
  /**
   * Providers the preamble may honestly advertise as reachable via
   * discovery this turn: granted, not yet activated, AND present in the
   * catalog (so `comparative__activate_tools` will actually accept them).
   * Deriving this here — not from grants alone — keeps the preamble from
   * promising a provider the activate tool would refuse (the honesty
   * spine). Empty in parity mode.
   */
  discoverableProviders: string[];
}

/**
 * Resolves the turn's activation set and (in "on" mode) the discovery
 * catalog for the model. Persistence stays sticky and additive via
 * `ensureThreadActivation`:
 * - parity: every granted provider (P1 byte-parity behavior).
 * - on: previously activated providers ∪ (granted ∩ core).
 */
export async function buildTurnToolDiscovery({
  db,
  thread,
  grantedProviders,
  mode,
}: {
  db: Database;
  thread: Pick<ChatThread, "id" | "mcpSignature">;
  grantedProviders: readonly string[];
  mode: Exclude<ToolDiscoveryMode, "off">;
}): Promise<TurnToolDiscovery> {
  const granted = new Set(grantedProviders);

  if (mode === "parity") {
    const persisted = await ensureThreadActivation(
      db,
      thread,
      grantedProviders,
    );
    // The stored set is sticky and may remember since-revoked grants; the
    // turn mounts granted providers only.
    return {
      activatedProviders: persisted.filter((provider) =>
        granted.has(provider),
      ),
      discoverableProviders: [],
    };
  }

  const seedProviders = [
    ...parseActivation(thread.mcpSignature).filter((provider) =>
      granted.has(provider),
    ),
    ...CORE_MCP_PROVIDERS.filter((provider) => granted.has(provider)),
  ];
  const persisted = await ensureThreadActivation(db, thread, seedProviders);
  const activatedProviders = persisted.filter((provider) =>
    granted.has(provider),
  );
  const catalog = await loadDiscoveryCatalog(db, grantedProviders);
  // Only providers that are granted AND have enabled catalog rows are
  // actually activatable, so only those may be advertised. A granted
  // provider whose catalog is absent/all-disabled is neither mounted nor
  // promised (the honesty spine — the preamble must never point the model
  // at a provider the activate tool will refuse).
  const activated = new Set(activatedProviders);
  const discoverableProviders = [
    ...new Set(catalog.map((entry) => entry.provider)),
  ].filter((provider) => granted.has(provider) && !activated.has(provider));
  return { activatedProviders, catalog, discoverableProviders };
}

/**
 * Catalog snapshot for the discovery tools: enabled rows for the user's
 * granted providers only. Descriptions are admin-curated metadata rendered
 * to the model as data — the tool result frames them as non-instructions.
 */
export async function loadDiscoveryCatalog(
  db: Database,
  grantedProviders: readonly string[],
): Promise<DiscoveryCatalogEntry[]> {
  if (grantedProviders.length === 0) return [];
  const rows = await db
    .select({
      provider: toolsCatalog.provider,
      toolName: toolsCatalog.toolName,
      displayName: toolsCatalog.displayName,
      description: toolsCatalog.description,
      category: toolsCatalog.category,
      action: toolsCatalog.action,
      enabled: toolsCatalog.enabled,
    })
    .from(toolsCatalog)
    .where(inArray(toolsCatalog.provider, [...grantedProviders]));

  return rows
    .filter((row) => row.enabled)
    .map((row) => ({
      provider: row.provider,
      tool: row.toolName,
      ...(row.displayName ? { displayName: row.displayName } : {}),
      description: row.description ?? "",
      category: row.category,
      action: row.action,
    }))
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.tool.localeCompare(right.tool),
    );
}
