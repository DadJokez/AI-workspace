import type { Database } from "@ai-workspace/db";
import { toolsCatalog, userToolAttestations } from "@ai-workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { toolActionKey, type ToolActionLevel } from "@/lib/tool-policy";

export interface ProviderAttestation {
  provider: string;
  scopeType: "provider" | "category" | "tool";
  category: string | null;
  toolCatalogId?: string | null;
  toolName: string | null;
  action: "read" | "write" | "admin";
}

export interface ToolCatalogPolicyEntry {
  id: string;
  provider: string;
  toolName: string;
  category: string;
  action: "read" | "write" | "admin";
  requiresAttestation: boolean;
  enabled: boolean;
}

export interface ProviderGateResult {
  allowedProviders: string[];
  deniedProviders: string[];
  toolPolicies: Record<
    string,
    { allowedTools?: string[]; blockedTools?: string[] }
  >;
  /**
   * Catalog action level per `provider__toolName` (#410): the input to the
   * tool-policy decision stamped on every execution audit row. Built from
   * the same catalog rows the attestation gate already loads.
   */
  toolActions: Record<string, ToolActionLevel>;
}

/**
 * MCP enforcement happens before model tool selection: providers are mounted
 * only when some active attestation permits them, and cataloged providers carry
 * an allow-list of enabled tool names. With no catalog rows we preserve the
 * older provider-wide behavior so existing broad approvals keep working.
 */
export function filterAttestedProviders(
  requestedProviders: readonly string[],
  attestations: readonly ProviderAttestation[],
  catalog: readonly ToolCatalogPolicyEntry[] = [],
): ProviderGateResult {
  const catalogByProvider = groupCatalogByProvider(catalog);

  const allowedProviders: string[] = [];
  const deniedProviders: string[] = [];
  const toolPolicies: ProviderGateResult["toolPolicies"] = {};
  const toolActions: ProviderGateResult["toolActions"] = {};
  for (const entry of catalog) {
    toolActions[toolActionKey(entry.provider, entry.toolName)] = entry.action;
  }

  for (const provider of requestedProviders) {
    const catalogRows = catalogByProvider.get(provider) ?? [];
    if (catalogRows.length === 0) {
      if (strongestProviderAction(provider, attestations)) {
        allowedProviders.push(provider);
        toolPolicies[provider] = {};
      } else {
        deniedProviders.push(provider);
      }
      continue;
    }

    const blockedTools = catalogRows
      .filter((tool) => !tool.enabled)
      .map((tool) => tool.toolName)
      .sort();
    const providerAction = strongestProviderAction(provider, attestations);
    if (providerAction === "admin") {
      allowedProviders.push(provider);
      toolPolicies[provider] =
        blockedTools.length > 0 ? { blockedTools } : {};
      continue;
    }

    const allowedTools = catalogRows
      .filter((tool) => isToolAllowed(tool, attestations))
      .map((tool) => tool.toolName)
      .sort();

    if (allowedTools.length > 0) {
      allowedProviders.push(provider);
      toolPolicies[provider] =
        blockedTools.length > 0
          ? { allowedTools, blockedTools }
          : { allowedTools };
    } else {
      deniedProviders.push(provider);
    }
  }

  return { allowedProviders, deniedProviders, toolPolicies, toolActions };
}

export async function loadActiveToolAttestations(
  db: Database,
  userId: string,
): Promise<ProviderAttestation[]> {
  return db
    .select({
      provider: userToolAttestations.provider,
      scopeType: userToolAttestations.scopeType,
      category: userToolAttestations.category,
      toolCatalogId: userToolAttestations.toolCatalogId,
      toolName: userToolAttestations.toolName,
      action: userToolAttestations.action,
    })
    .from(userToolAttestations)
    .where(
      and(
        eq(userToolAttestations.userId, userId),
        isNull(userToolAttestations.revokedAt),
      ),
    );
}

export async function loadToolCatalogForProviders(
  db: Database,
  providers: readonly string[],
): Promise<ToolCatalogPolicyEntry[]> {
  if (providers.length === 0) return [];
  return db
    .select({
      id: toolsCatalog.id,
      provider: toolsCatalog.provider,
      toolName: toolsCatalog.toolName,
      category: toolsCatalog.category,
      action: toolsCatalog.action,
      requiresAttestation: toolsCatalog.requiresAttestation,
      enabled: toolsCatalog.enabled,
    })
    .from(toolsCatalog)
    .where(inArray(toolsCatalog.provider, [...providers]));
}

function groupCatalogByProvider(
  catalog: readonly ToolCatalogPolicyEntry[],
): Map<string, ToolCatalogPolicyEntry[]> {
  const grouped = new Map<string, ToolCatalogPolicyEntry[]>();
  for (const tool of catalog) {
    const existing = grouped.get(tool.provider) ?? [];
    existing.push(tool);
    grouped.set(tool.provider, existing);
  }
  return grouped;
}

function strongestProviderAction(
  provider: string,
  attestations: readonly ProviderAttestation[],
): ProviderAttestation["action"] | null {
  const providerRows = attestations.filter(
    (row) => row.provider === provider && row.scopeType === "provider",
  );
  if (providerRows.some((row) => row.action === "admin")) return "admin";
  if (providerRows.some((row) => row.action === "write")) return "write";
  if (providerRows.some((row) => row.action === "read")) return "read";
  return null;
}

function isToolAllowed(
  tool: ToolCatalogPolicyEntry,
  attestations: readonly ProviderAttestation[],
): boolean {
  if (!tool.enabled) return false;
  if (!tool.requiresAttestation) {
    // Non-attested catalog tools skip per-tool approval, but they still require
    // an active provider-level attestation that covers the tool action.
    const providerAction = strongestProviderAction(tool.provider, attestations);
    return providerAction
      ? actionCovers(providerAction, tool.action)
      : false;
  }

  return attestations.some((row) => {
    if (row.provider !== tool.provider) return false;
    if (!actionCovers(row.action, tool.action)) return false;
    if (row.scopeType === "provider") return true;
    if (row.scopeType === "category") return row.category === tool.category;
    if (row.scopeType === "tool") {
      return row.toolCatalogId === tool.id || row.toolName === tool.toolName;
    }
    return false;
  });
}

function actionCovers(
  granted: ProviderAttestation["action"],
  required: ToolCatalogPolicyEntry["action"],
): boolean {
  const rank = { read: 1, write: 2, admin: 3 } as const;
  return rank[granted] >= rank[required];
}
