import type { Database } from "@ai-workspace/db";
import { userToolAttestations } from "@ai-workspace/db";
import { and, eq, isNull } from "drizzle-orm";

export interface ProviderAttestation {
  provider: string;
  scopeType: "provider" | "category" | "tool";
  category: string | null;
  toolName: string | null;
  action: "read" | "write" | "admin";
}

export interface ProviderGateResult {
  allowedProviders: string[];
  deniedProviders: string[];
}

/**
 * Current Cursor MCP enforcement point is provider mounting: if a provider is
 * not approved, we do not expose its MCP server to the runtime for this turn.
 * Tool/category rows are still loaded for the future lower-level MCP proxy,
 * but only provider-scope attestations can safely expose a whole provider.
 */
export function filterAttestedProviders(
  requestedProviders: readonly string[],
  attestations: readonly ProviderAttestation[],
): ProviderGateResult {
  const providerApproved = new Set(
    attestations
      .filter((row) => row.scopeType === "provider")
      .map((row) => row.provider),
  );

  const allowedProviders: string[] = [];
  const deniedProviders: string[] = [];
  for (const provider of requestedProviders) {
    if (providerApproved.has(provider)) {
      allowedProviders.push(provider);
    } else {
      deniedProviders.push(provider);
    }
  }

  return { allowedProviders, deniedProviders };
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
