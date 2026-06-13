import type { Database } from "@ai-workspace/db";
import { oauthTokens } from "@ai-workspace/db";
import type { McpServerSpec } from "@ai-workspace/cursor-runtime";
import { eq } from "drizzle-orm";

import { decryptSecret } from "./crypto";
import {
  filterAttestedProviders,
  loadActiveToolAttestations,
} from "@/lib/tool-attestations";

const MCP_ENDPOINTS: Record<string, { url: string }> = {
  github: { url: "https://api.githubcopilot.com/mcp/" },
  // notion / google land here when their OAuth flows ship.
};

/** Provider slugs AI Hub can mount today; skills validate against this. */
export const SUPPORTED_MCP_PROVIDERS = Object.keys(MCP_ENDPOINTS);

export interface UserMcpProviderStatus {
  connectedProviders: string[];
  allowedProviders: string[];
  deniedProviders: string[];
}

export async function loadUserMcpProviderStatus(
  db: Database,
  userId: string,
  options?: { onlyProviders?: string[] },
): Promise<UserMcpProviderStatus> {
  let rows;
  try {
    rows = await db
      .select({ provider: oauthTokens.provider })
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId));
  } catch (err) {
    console.warn("[mcp] oauth_tokens lookup failed:", err);
    return {
      connectedProviders: [],
      allowedProviders: [],
      deniedProviders: [],
    };
  }

  if (options?.onlyProviders) {
    const allowlist = new Set(options.onlyProviders);
    rows = rows.filter((row) => allowlist.has(row.provider));
  }

  const connectedProviders = [
    ...new Set(
      rows
        .map((row) => row.provider)
        .filter((provider) => MCP_ENDPOINTS[provider]),
    ),
  ];

  try {
    const attestations = await loadActiveToolAttestations(db, userId);
    const gated = filterAttestedProviders(connectedProviders, attestations);
    return {
      connectedProviders,
      allowedProviders: gated.allowedProviders,
      deniedProviders: gated.deniedProviders,
    };
  } catch (err) {
    console.warn("[mcp] attestation lookup failed; denying MCP providers:", err);
    return {
      connectedProviders,
      allowedProviders: [],
      deniedProviders: connectedProviders,
    };
  }
}

/**
 * Look up the user's connected providers from `oauth_tokens` and return a
 * Cursor-SDK `mcpServers` map keyed by provider name. The access token is
 * decrypted in process and passed as a Bearer header.
 *
 * Graceful degradation: any DB / decrypt / unsupported-provider error for a
 * single row is logged and skipped. The chat turn proceeds without that
 * provider. Total failure (e.g. DB unreachable) returns undefined and the
 * caller runs MCP-less.
 */
export async function buildUserMcpServers(
  db: Database,
  userId: string,
  options?: {
    /**
     * Restrict mounting to this provider allowlist (skill runs declare their
     * providers). `undefined` = mount everything connected and attested
     * (chat behavior); `[]` = mount nothing.
     */
    onlyProviders?: string[];
  },
): Promise<{
  mcpServers: Record<string, McpServerSpec> | undefined;
  deniedProviders: string[];
}> {
  let rows;
  try {
    rows = await db
      .select({
        provider: oauthTokens.provider,
        accessToken: oauthTokens.accessToken,
      })
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId));
  } catch (err) {
    console.warn("[mcp] oauth_tokens lookup failed:", err);
    return { mcpServers: undefined, deniedProviders: [] };
  }

  if (options?.onlyProviders) {
    const allowlist = new Set(options.onlyProviders);
    rows = rows.filter((row) => allowlist.has(row.provider));
  }

  const status = await loadUserMcpProviderStatus(db, userId, {
    onlyProviders: options?.onlyProviders,
  });
  const allowedProviders = status.allowedProviders;
  const deniedProviders = status.deniedProviders;
  const allowed = new Set(allowedProviders);

  const out: Record<string, McpServerSpec> = {};
  for (const row of rows) {
    const endpoint = MCP_ENDPOINTS[row.provider];
    if (!endpoint) continue;
    if (!allowed.has(row.provider)) continue;
    let token: string;
    try {
      token = decryptSecret(row.accessToken);
    } catch (err) {
      console.warn(`[mcp] decrypt failed for ${row.provider}:`, err);
      continue;
    }
    out[row.provider] = {
      type: "http",
      url: endpoint.url,
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  return {
    mcpServers: Object.keys(out).length > 0 ? out : undefined,
    deniedProviders,
  };
}
