import { mcpToolName } from "@ai-workspace/agent";
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
  GOOGLE_MCP_CONTEXT_HEADER,
  GOOGLE_MCP_PATH,
  GOOGLE_MCP_RELAY_HEADER,
  buildGoogleTurnContext,
  googleMcpRelayToken,
  signGoogleTurnContext,
  type DraftAuthorizationReason,
  type GoogleHistoryMessage,
  type GoogleTurnContext,
} from "@/lib/google/write-authorization";
import {
  resolveGoogleConnection,
  type GoogleConnectionState,
} from "@/lib/oauth/google-token";
import {
  SALESFORCE_MCP_CONTEXT_HEADER,
  SALESFORCE_MCP_PATH,
  SALESFORCE_MCP_RELAY_HEADER,
  buildSalesforceTurnContext,
  salesforceMcpRelayToken,
  signSalesforceTurnContext,
} from "@/lib/salesforce/authorization";
import {
  resolveSalesforceConnection,
  type SalesforceConnectionState,
} from "@/lib/oauth/salesforce-token";
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
  google: { endpoint: { url: new URL(GOOGLE_MCP_PATH, PUBLIC_BASE_URL).toString() } },
  salesforce: {
    endpoint: { url: new URL(SALESFORCE_MCP_PATH, PUBLIC_BASE_URL).toString() },
  },
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

/**
 * True only when a provider is unavailable *because its integration is not
 * shipped yet* ("coming soon"), as opposed to a broken/misconfigured endpoint
 * (`invalid_endpoint_url`, `hosted_notion_mcp_uses_separate_oauth`) or a
 * generic `execution_not_configured`. The "linked, nothing is broken, coming
 * soon" reassurance in the preamble and capability graph must key off this and
 * never the blanket "execution unavailable" flag — otherwise a genuinely
 * misconfigured provider gets a false "nothing is missing on your side" (#323
 * review).
 */
export function isProviderComingSoon(provider: string): boolean {
  return (
    getMcpProviderExecutionStatus(provider).reason === "integration_coming_soon"
  );
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
  /** Connected Google grants that must be renewed before tools can mount. */
  reconnectRequiredProviders?: string[];
  /**
   * Subset of `executionUnavailableProviders` whose reason is specifically
   * "integration_coming_soon" (linked, nothing broken, ships later) — not a
   * misconfigured or unknown-reason unavailability. Consumers reserve the
   * reassuring "coming soon" copy for these only.
   */
  comingSoonProviders?: string[];
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
        | "reconnect_required"
        | "temporarily_unavailable"
        | "execution_not_configured"
        | "unsupported_provider";
      reason?: string;
    }
  >;
}

export interface McpTurnContext {
  runId: string;
  threadId: string;
  prompt: string;
  history: readonly GoogleHistoryMessage[];
  interactive: boolean;
}

export interface McpWriteAuthorizationReceipt {
  provider: "google";
  tool: "create_draft";
  allowed: boolean;
  reason: DraftAuthorizationReason;
}

export async function loadUserMcpProviderStatus(
  db: Database,
  userId: string,
  options?: { onlyProviders?: string[] },
): Promise<UserMcpProviderStatus> {
  let rows: Array<{ provider: string; expiresAt: Date | string | null }>;
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
      comingSoonProviders: [],
      toolPolicies: {},
      providerAvailability: {},
    };
  }

  let googleConnection: GoogleConnectionState | null = null;
  if (
    rows.some((row) => row.provider === "google") &&
    (!options?.onlyProviders || options.onlyProviders.includes("google"))
  ) {
    try {
      googleConnection = await resolveGoogleConnection(db, userId);
    } catch (err) {
      console.warn("[mcp] Google connection status failed:", err);
      googleConnection = {
        status: "temporarily_unavailable",
        connected: true,
        ready: false,
        reason: "token_refresh_failed",
        grantedScopes: [],
      };
    }
  }

  let salesforceConnection: SalesforceConnectionState | null = null;
  if (
    rows.some((row) => row.provider === "salesforce") &&
    (!options?.onlyProviders || options.onlyProviders.includes("salesforce"))
  ) {
    try {
      salesforceConnection = await resolveSalesforceConnection(db, userId);
    } catch (err) {
      console.warn("[mcp] Salesforce connection status failed:", err);
      salesforceConnection = {
        status: "temporarily_unavailable",
        connected: true,
        ready: false,
        reason: "token_refresh_failed",
        grantedScopes: [],
      };
    }
  }

  const connectedProviders = uniqueSupportedProviders(
    rows,
    options,
    googleConnection,
    salesforceConnection,
  );
  const {
    allowedProviders: attestedProviders,
    deniedProviders,
    toolPolicies: attestedToolPolicies,
  } =
    await resolveAttestedProviders(db, userId, connectedProviders);
  const credentialUnavailableProviders = attestedProviders.filter(
    (provider) =>
      (provider === "google" && googleConnection?.ready !== true) ||
      (provider === "salesforce" && salesforceConnection?.ready !== true),
  );
  const allowedProviders = attestedProviders.filter(
    (provider) =>
      isMcpProviderExecutionConfigured(provider) &&
      !credentialUnavailableProviders.includes(provider),
  );
  const executionUnavailableProviders = attestedProviders.filter(
    (provider) => !isMcpProviderExecutionConfigured(provider),
  );
  const comingSoonProviders = executionUnavailableProviders.filter(
    isProviderComingSoon,
  );
  const reconnectRequiredProviders = [
    ...(googleConnection?.status === "reconnect_required" ? ["google"] : []),
    ...(salesforceConnection?.status === "reconnect_required"
      ? ["salesforce"]
      : []),
  ];
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
    reconnectRequiredProviders,
    comingSoonProviders,
    toolPolicies,
    providerAvailability: buildProviderAvailability({
      connectedProviders,
      attestedProviders,
      allowedProviders,
      deniedProviders,
      executionUnavailableProviders,
      googleConnection,
      salesforceConnection,
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
    turnContext?: McpTurnContext;
  },
): Promise<{
  mcpServers: Record<string, McpServerSpec> | undefined;
  deniedProviders: string[];
  requiredToolName?: string;
  writeAuthorizationReceipts: McpWriteAuthorizationReceipt[];
}> {
  const googleTurnContext = buildGoogleTurnContext({
    userId,
    threadId: options?.turnContext?.threadId ?? "read-only",
    runId: options?.turnContext?.runId ?? "read-only",
    prompt: options?.turnContext?.prompt ?? "",
    history: options?.turnContext?.history ?? [],
    interactive: options?.turnContext?.interactive === true,
  });
  const requiredToolName = googleTurnContext.confirmedEventProposal
    ? mcpToolName("google", "create_event")
    : undefined;
  const draftAuthorization = googleTurnContext.draftAuthorization ?? {
    allowed: false,
    reason: "denied_no_directive" as const,
  };
  const writeAuthorizationReceipts: McpWriteAuthorizationReceipt[] = [
    {
      provider: "google",
      tool: "create_draft",
      ...draftAuthorization,
    },
  ];
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
    return {
      mcpServers: undefined,
      deniedProviders: [],
      writeAuthorizationReceipts,
      ...(requiredToolName ? { requiredToolName } : {}),
    };
  }

  rows = rows.filter(
    (row) =>
      row.provider === "google" ||
      row.provider === "salesforce" ||
      isActiveOAuthToken(row),
  );

  if (options?.onlyProviders) {
    const allowlist = new Set(options.onlyProviders);
    rows = rows.filter((row) => allowlist.has(row.provider));
  }
  rows = [...rows].sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );

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
    let salesforceInstanceUrl: string | null = null;
    if (row.provider === "google") {
      try {
        const connection = await resolveGoogleConnection(db, userId);
        if (!connection.ready) continue;
        token = connection.accessToken;
      } catch (err) {
        console.warn("[mcp] Google token resolution failed:", err);
        continue;
      }
    } else if (row.provider === "salesforce") {
      try {
        const connection = await resolveSalesforceConnection(db, userId);
        if (!connection.ready) continue;
        token = connection.accessToken;
        salesforceInstanceUrl = connection.instanceUrl;
      } catch (err) {
        console.warn("[mcp] Salesforce token resolution failed:", err);
        continue;
      }
    } else {
      try {
        token = decryptSecret(row.accessToken);
      } catch (err) {
        console.warn(`[mcp] decrypt failed for ${row.provider}:`, err);
        continue;
      }
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
    if (
      row.provider === "google" &&
      isFirstPartyGoogleMcpEndpoint(endpoint.url)
    ) {
      try {
        headers[GOOGLE_MCP_RELAY_HEADER] = googleMcpRelayToken();
        headers[GOOGLE_MCP_CONTEXT_HEADER] =
          signGoogleTurnContext(googleTurnContext);
      } catch (err) {
        console.warn("[mcp] Google relay signing failed:", err);
        continue;
      }
    }
    if (row.provider === "salesforce") {
      if (
        !salesforceInstanceUrl ||
        !isFirstPartySalesforceMcpEndpoint(endpoint.url)
      ) {
        continue;
      }
      try {
        headers[SALESFORCE_MCP_RELAY_HEADER] = salesforceMcpRelayToken();
        headers[SALESFORCE_MCP_CONTEXT_HEADER] = signSalesforceTurnContext(
          buildSalesforceTurnContext({
            userId,
            instanceUrl: salesforceInstanceUrl,
          }),
        );
      } catch (err) {
        console.warn("[mcp] Salesforce relay signing failed:", err);
        continue;
      }
    }
    const resolvedToolPolicy =
      row.provider === "google"
        ? applyGoogleTurnToolPolicy(toolPolicy, googleTurnContext)
        : toolPolicy;
    out[row.provider] = {
      type: "http",
      url: endpoint.url,
      headers,
      ...resolvedToolPolicy,
    };
  }
  return {
    mcpServers: Object.keys(out).length > 0 ? out : undefined,
    deniedProviders,
    writeAuthorizationReceipts,
    ...(requiredToolName ? { requiredToolName } : {}),
  };
}

function buildProviderAvailability({
  connectedProviders,
  attestedProviders,
  allowedProviders,
  deniedProviders,
  executionUnavailableProviders,
  googleConnection,
  salesforceConnection,
}: {
  connectedProviders: readonly string[];
  attestedProviders: readonly string[];
  allowedProviders: readonly string[];
  deniedProviders: readonly string[];
  executionUnavailableProviders: readonly string[];
  googleConnection: GoogleConnectionState | null;
  salesforceConnection: SalesforceConnectionState | null;
}): UserMcpProviderStatus["providerAvailability"] {
  const attested = new Set(attestedProviders);
  const allowed = new Set(allowedProviders);
  const denied = new Set(deniedProviders);
  const unavailable = new Set(executionUnavailableProviders);
  return Object.fromEntries(
    connectedProviders.map((provider) => {
      const execution = getMcpProviderExecutionStatus(provider);
      const modelAvailable = allowed.has(provider);
      const credentialState =
        provider === "google"
          ? googleConnection
          : provider === "salesforce"
            ? salesforceConnection
            : null;
      const status = modelAvailable
        ? "ready"
        : credentialState?.status === "reconnect_required"
          ? "reconnect_required"
          : credentialState?.status === "temporarily_unavailable"
            ? "temporarily_unavailable"
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
          tokenValid: credentialState ? credentialState.ready : true,
          userApproved: attested.has(provider),
          executionConfigured: execution.executionConfigured,
          toolMountable: modelAvailable,
          modelAvailable,
          status,
          ...(credentialState && "reason" in credentialState
            ? { reason: credentialState.reason }
            : execution.reason
              ? { reason: execution.reason }
              : {}),
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

function isFirstPartyGoogleMcpEndpoint(rawUrl: string): boolean {
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(GOOGLE_MCP_PATH, PUBLIC_BASE_URL);
    return (
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function isFirstPartySalesforceMcpEndpoint(rawUrl: string): boolean {
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(SALESFORCE_MCP_PATH, PUBLIC_BASE_URL);
    return (
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

const GOOGLE_READ_AND_PREPARE_TOOLS = [
  "search_mail",
  "get_message",
  "get_thread",
  "list_calendars",
  "list_events",
  "get_event",
  "query_free_busy",
  "prepare_event",
] as const;

function applyGoogleTurnToolPolicy(
  policy: { allowedTools?: string[]; blockedTools?: string[] },
  turnContext: GoogleTurnContext,
): { allowedTools: string[]; blockedTools?: string[] } {
  const readAndPrepareTools = turnContext.confirmedEventProposal
    ? GOOGLE_READ_AND_PREPARE_TOOLS.filter((tool) => tool !== "prepare_event")
    : GOOGLE_READ_AND_PREPARE_TOOLS;
  const availableThisTurn = new Set<string>([
    ...readAndPrepareTools,
    ...turnContext.allowedWrites,
  ]);
  const allowedTools = (
    policy.allowedTools ?? Array.from(availableThisTurn)
  ).filter((tool) => availableThisTurn.has(tool));
  return {
    allowedTools,
    ...(policy.blockedTools ? { blockedTools: policy.blockedTools } : {}),
  };
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
  googleConnection?: GoogleConnectionState | null,
  salesforceConnection?: SalesforceConnectionState | null,
): string[] {
  const allowlist = options?.onlyProviders
    ? new Set(options.onlyProviders)
    : null;
  return Array.from(
    new Set(
      rows
        .filter((row) =>
          row.provider === "google"
            ? googleConnection?.connected === true
            : row.provider === "salesforce"
              ? salesforceConnection?.connected === true
              : isActiveOAuthToken(row),
        )
        .map((row) => row.provider)
        .filter((provider) =>
          SUPPORTED_MCP_PROVIDERS.includes(provider),
        )
        .filter((provider) => !allowlist || allowlist.has(provider)),
    ),
  ).sort((left, right) => left.localeCompare(right));
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
