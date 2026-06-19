import type { Database } from "@ai-workspace/db";
import { oauthTokens } from "@ai-workspace/db";
import type { McpServerSpec } from "@ai-workspace/agent-runtime";
import { eq } from "drizzle-orm";

import { decryptSecret } from "./crypto";
import { PUBLIC_BASE_URL } from "@/lib/oauth/github";
import {
  NOTION_MCP_PATH,
  NOTION_MCP_RELAY_HEADER,
  notionMcpRelayToken,
} from "@/lib/notion/mcp";
import {
  filterAttestedProviders,
  loadActiveToolAttestations,
  loadToolCatalogForProviders,
} from "@/lib/tool-attestations";

interface McpProviderConfig {
  endpoint?: { url: string };
  unavailableReason?: string;
}

const MCP_PROVIDER_CONFIG: Record<string, McpProviderConfig> = {
  github: { endpoint: { url: "https://api.githubcopilot.com/mcp/" } },
  notion: notionMcpConfig(process.env.NOTION_MCP_ENDPOINT_URL),
};

/**
 * Provider slugs Comparative knows how to connect/configure. A provider may be
 * connectable before it is executable in the current deployment.
 */
export const SUPPORTED_MCP_PROVIDERS = Object.keys(MCP_PROVIDER_CONFIG);

/** Provider slugs whose MCP endpoint is actually configured for this process. */
export const MOUNTABLE_MCP_PROVIDERS = SUPPORTED_MCP_PROVIDERS.filter((provider) =>
  isMcpProviderExecutionConfigured(provider),
);

export interface McpProviderExecutionStatus {
  executionConfigured: boolean;
  reason?: string;
}

export function getMcpProviderExecutionStatus(
  provider: string,
): McpProviderExecutionStatus {
  const config = MCP_PROVIDER_CONFIG[provider];
  if (!config) {
    return { executionConfigured: false, reason: "unsupported_provider" };
  }
  if (!config.endpoint) {
    return {
      executionConfigured: false,
      reason: config.unavailableReason ?? "execution_not_configured",
    };
  }
  return { executionConfigured: true };
}

export function isMcpProviderExecutionConfigured(provider: string): boolean {
  return Boolean(MCP_PROVIDER_CONFIG[provider]?.endpoint);
}

export interface UserMcpProviderStatus {
  /** Active delegated OAuth/token connections, regardless of runtime mounting. */
  connectedProviders: string[];
  /** Connected + attested + executable in the current deployment. */
  allowedProviders: string[];
  /** Connected but blocked by user/tool attestation. */
  deniedProviders: string[];
  /** Connected + attested, but this deployment cannot mount the provider yet. */
  executionUnavailableProviders?: string[];
  toolPolicies?: Record<
    string,
    { allowedTools?: string[]; blockedTools?: string[] }
  >;
  providerAvailability?: Record<
    string,
    {
      connected: boolean;
      tokenValid: boolean;
      userApproved: boolean;
      executionConfigured: boolean;
      toolMountable: boolean;
      modelAvailable: boolean;
      status:
        | "ready"
        | "pending_approval"
        | "execution_not_configured"
        | "unsupported_provider";
    }
  >;
}

export async function loadUserMcpProviderStatus(
  db: Database,
  userId: string,
  options?: { onlyProviders?: string[] },
): Promise<UserMcpProviderStatus> {
  let rows: Array<{ provider: string }>;
  try {
    rows = await db
      .select({
        provider: oauthTokens.provider,
        expiresAt: oauthTokens.expiresAt,
      })
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId));
  } catch (err) {
    console.warn("[mcp] oauth_tokens provider lookup failed:", err);
    return {
      connectedProviders: [],
      allowedProviders: [],
      deniedProviders: [],
      executionUnavailableProviders: [],
      toolPolicies: {},
      providerAvailability: {},
    };
  }

  const connectedProviders = uniqueSupportedProviders(rows, options);
  const {
    allowedProviders: attestedProviders,
    deniedProviders,
    toolPolicies: attestedToolPolicies,
  } =
    await resolveAttestedProviders(db, userId, connectedProviders);
  const allowedProviders = attestedProviders.filter((provider) =>
    isMcpProviderExecutionConfigured(provider),
  );
  const executionUnavailableProviders = attestedProviders.filter(
    (provider) => !isMcpProviderExecutionConfigured(provider),
  );
  const toolPolicies = Object.fromEntries(
    Object.entries(attestedToolPolicies).filter(([provider]) =>
      allowedProviders.includes(provider),
    ),
  );

  return {
    connectedProviders,
    allowedProviders,
    deniedProviders,
    executionUnavailableProviders,
    toolPolicies,
    providerAvailability: buildProviderAvailability({
      connectedProviders,
      attestedProviders,
      allowedProviders,
      deniedProviders,
      executionUnavailableProviders,
    }),
  };
}

/**
 * Look up the user's connected providers from `oauth_tokens` and return an
 * `mcpServers` map keyed by provider name. The access token is decrypted in
 * process and passed as a Bearer header.
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
        expiresAt: oauthTokens.expiresAt,
      })
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId));
  } catch (err) {
    console.warn("[mcp] oauth_tokens lookup failed:", err);
    return { mcpServers: undefined, deniedProviders: [] };
  }

  rows = rows.filter(isActiveOAuthToken);

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
    const endpoint = MCP_PROVIDER_CONFIG[row.provider]?.endpoint;
    if (!endpoint) continue;
    const toolPolicy = status.toolPolicies?.[row.provider];
    if (!allowed.has(row.provider) || !toolPolicy) continue;
    let token: string;
    try {
      token = decryptSecret(row.accessToken);
    } catch (err) {
      console.warn(`[mcp] decrypt failed for ${row.provider}:`, err);
      continue;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (
      row.provider === "notion" &&
      isFirstPartyNotionMcpEndpoint(endpoint.url)
    ) {
      try {
        headers[NOTION_MCP_RELAY_HEADER] = notionMcpRelayToken();
      } catch (err) {
        console.warn("[mcp] Notion relay token generation failed:", err);
        continue;
      }
    }
    out[row.provider] = {
      type: "http",
      url: endpoint.url,
      headers,
      ...toolPolicy,
    };
  }
  return {
    mcpServers: Object.keys(out).length > 0 ? out : undefined,
    deniedProviders,
  };
}

function buildProviderAvailability({
  connectedProviders,
  attestedProviders,
  allowedProviders,
  deniedProviders,
  executionUnavailableProviders,
}: {
  connectedProviders: readonly string[];
  attestedProviders: readonly string[];
  allowedProviders: readonly string[];
  deniedProviders: readonly string[];
  executionUnavailableProviders: readonly string[];
}): UserMcpProviderStatus["providerAvailability"] {
  const attested = new Set(attestedProviders);
  const allowed = new Set(allowedProviders);
  const denied = new Set(deniedProviders);
  const unavailable = new Set(executionUnavailableProviders);
  return Object.fromEntries(
    connectedProviders.map((provider) => {
      const execution = getMcpProviderExecutionStatus(provider);
      const modelAvailable = allowed.has(provider);
      const status = modelAvailable
        ? "ready"
        : denied.has(provider)
          ? "pending_approval"
          : unavailable.has(provider)
            ? "execution_not_configured"
            : execution.reason === "unsupported_provider"
              ? "unsupported_provider"
              : "pending_approval";
      return [
        provider,
        {
          connected: true,
          tokenValid: true,
          userApproved: attested.has(provider),
          executionConfigured: execution.executionConfigured,
          toolMountable: modelAvailable,
          modelAvailable,
          status,
        },
      ];
    }),
  );
}

function notionMcpConfig(rawUrl: string | undefined): McpProviderConfig {
  const value = rawUrl?.trim();
  const endpoint = value
    ? parseMcpEndpoint(value)
    : { url: new URL(NOTION_MCP_PATH, PUBLIC_BASE_URL).toString() };
  if (!endpoint) return { unavailableReason: "invalid_endpoint_url" };
  try {
    const url = new URL(endpoint.url);
    if (url.hostname === "mcp.notion.com") {
      return { unavailableReason: "hosted_notion_mcp_uses_separate_oauth" };
    }
  } catch {
    return { unavailableReason: "invalid_endpoint_url" };
  }
  return { endpoint };
}

function isFirstPartyNotionMcpEndpoint(rawUrl: string): boolean {
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(NOTION_MCP_PATH, PUBLIC_BASE_URL);
    return (
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function parseMcpEndpoint(rawUrl: string | undefined): { url: string } | undefined {
  const value = rawUrl?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return { url: url.toString() };
  } catch {
    return undefined;
  }
}

function uniqueSupportedProviders(
  rows: Array<{ provider: string; expiresAt?: Date | string | null }>,
  options?: { onlyProviders?: string[] },
): string[] {
  const allowlist = options?.onlyProviders
    ? new Set(options.onlyProviders)
    : null;
  return Array.from(
    new Set(
      rows
        .filter(isActiveOAuthToken)
        .map((row) => row.provider)
        .filter((provider) =>
          SUPPORTED_MCP_PROVIDERS.includes(provider),
        )
        .filter((provider) => !allowlist || allowlist.has(provider)),
    ),
  );
}

function isActiveOAuthToken(row: {
  expiresAt?: Date | string | null;
}): boolean {
  if (!row.expiresAt) return true;
  const expiresAt =
    row.expiresAt instanceof Date
      ? row.expiresAt.getTime()
      : Date.parse(row.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function resolveAttestedProviders(
  db: Database,
  userId: string,
  requestedProviders: string[],
): Promise<{
  allowedProviders: string[];
  deniedProviders: string[];
  toolPolicies: Record<
    string,
    { allowedTools?: string[]; blockedTools?: string[] }
  >;
}> {
  if (requestedProviders.length === 0) {
    return { allowedProviders: [], deniedProviders: [], toolPolicies: {} };
  }
  try {
    const [attestations, catalog] = await Promise.all([
      loadActiveToolAttestations(db, userId),
      loadToolCatalogForProviders(db, requestedProviders),
    ]);
    return filterAttestedProviders(requestedProviders, attestations, catalog);
  } catch (err) {
    console.warn("[mcp] attestation lookup failed; denying MCP providers:", err);
    return {
      allowedProviders: [],
      deniedProviders: requestedProviders,
      toolPolicies: {},
    };
  }
}
