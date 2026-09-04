import { connectMcpTools, mcpToolName } from "@ai-workspace/agent";
import type { Database } from "@ai-workspace/db";
import {
  LEGACY_SOQL_PROVIDER,
  LEGACY_SOQL_TOOL_NAME,
  type DataBinding,
} from "@/lib/app-data-bindings";
import { providerSupportsViewerIdentity } from "@/lib/app-binding-providers";
import {
  buildUserMcpServers,
  loadUserMcpProviderStatus,
} from "@/lib/oauth/mcp-servers";
import { resolveSalesforceConnection } from "@/lib/oauth/salesforce-token";
import {
  queryReadOnlySoql,
  SalesforceApiError,
  validateReadOnlySoql,
} from "@/lib/salesforce/api";
import { buildSalesforceTurnContext } from "@/lib/salesforce/authorization";
import { toolActionKey } from "@/lib/tool-policy";

/**
 * Execute one pinned binding as the VIEWER (#802). This is the same
 * per-user machinery a chat turn mounts tools through, applied to a single
 * pinned read call:
 *
 *   viewer's oauth_tokens → connector registry → attestation + tri-state
 *   policy (#410) → catalog read-only check → execute → (caller audits).
 *
 * There is no fallback identity: a viewer without a ready, attested
 * connection gets `needs_connection` (the app renders its connect prompt),
 * never the author's or any other user's data. Upstream error text never
 * leaves this module — providers echo submitted arguments in their errors,
 * and the author's pinned arguments must not reach a viewer's browser or an
 * audit row. Only a category survives.
 */
export type AppDataExecution =
  | {
      kind: "ok";
      /** The tool's output (structured content when the server sends it). */
      data: unknown;
      rowCount?: number;
      /** Top-level fields kept for pages built against the #407 contract. */
      legacyFields?: Record<string, unknown>;
    }
  | { kind: "needs_connection"; connectionStatus: string }
  | { kind: "invalid_binding" }
  | { kind: "denied"; reason: string }
  | { kind: "source_error"; category: string };

export async function executeAppDataBinding({
  db,
  viewerUserId,
  binding,
}: {
  db: Database;
  viewerUserId: string;
  binding: DataBinding;
}): Promise<AppDataExecution> {
  if (!providerSupportsViewerIdentity(binding.provider)) {
    return { kind: "denied", reason: "provider_not_viewer_identity" };
  }

  // Defense-in-depth: pinned arguments are re-validated at fetch time where a
  // validator exists — never trust that publish-time validation is intact.
  const isLegacySoql =
    binding.provider === LEGACY_SOQL_PROVIDER &&
    binding.toolName === LEGACY_SOQL_TOOL_NAME;
  let safeSoql: string | null = null;
  if (isLegacySoql) {
    const soql = binding.pinnedArgs.soql;
    try {
      safeSoql = validateReadOnlySoql(typeof soql === "string" ? soql : "");
    } catch {
      return { kind: "invalid_binding" };
    }
  }

  // The viewer's own provider state: connection, org registry, attestation,
  // and the persisted per-tool policy — all scoped to `viewerUserId`.
  const status = await loadUserMcpProviderStatus(db, viewerUserId, {
    onlyProviders: [binding.provider],
  });
  if (!status.connectedProviders.includes(binding.provider)) {
    return { kind: "needs_connection", connectionStatus: "not_connected" };
  }
  const availability = status.providerAvailability?.[binding.provider];
  if (!availability || availability.status !== "ready") {
    return {
      kind: "needs_connection",
      connectionStatus: availability?.status ?? "not_connected",
    };
  }
  const policy =
    status.toolPolicyDecisions?.[
      toolActionKey(binding.provider, binding.toolName)
    ];
  if (policy !== "always_allow") {
    return {
      kind: "denied",
      reason: policy ? "tool_policy_not_always_allow" : "tool_not_cataloged",
    };
  }
  const toolPolicy = status.toolPolicies?.[binding.provider];
  if (toolPolicy?.blockedTools?.includes(binding.toolName)) {
    return { kind: "denied", reason: "tool_disabled" };
  }
  if (toolPolicy?.allowedTools && !toolPolicy.allowedTools.includes(binding.toolName)) {
    // Connected, but this viewer has not approved this tool yet.
    return { kind: "needs_connection", connectionStatus: "pending_approval" };
  }

  if (safeSoql !== null) return executeLegacySoql(db, viewerUserId, safeSoql);
  return executeCatalogTool(db, viewerUserId, binding);
}

/**
 * The #407 structured-rows path: `queryReadOnlySoql` returns rows without
 * model framing, which is what a page's Refresh renders. The MCP relay's
 * `run_soql` output is nonce-framed for the model, so Salesforce SOQL keeps
 * this direct executor; every other read tool goes through MCP below.
 */
async function executeLegacySoql(
  db: Database,
  viewerUserId: string,
  safeSoql: string,
): Promise<AppDataExecution> {
  const connection = await resolveSalesforceConnection(db, viewerUserId);
  if (connection.status !== "ready") {
    return { kind: "needs_connection", connectionStatus: connection.status };
  }
  try {
    const result = await queryReadOnlySoql(safeSoql, {
      accessToken: connection.accessToken,
      turnContext: buildSalesforceTurnContext({
        userId: viewerUserId,
        instanceUrl: connection.instanceUrl,
      }),
    });
    const legacyFields = {
      records: result.records,
      totalSize: result.totalSize,
      done: result.done,
    };
    return {
      kind: "ok",
      data: legacyFields,
      rowCount: result.records.length,
      legacyFields,
    };
  } catch (err) {
    const upstreamStatus =
      err instanceof SalesforceApiError ? err.status : null;
    return {
      kind: "source_error",
      category: upstreamStatus
        ? `salesforce_error_${upstreamStatus}`
        : "data_source_unreachable",
    };
  }
}

/**
 * Generic path: mount ONLY this provider for the viewer (the same spec a
 * chat turn would get — viewer bearer token, relay headers, catalog tool
 * policies), call the one pinned tool, close. The mounted tool's own policy
 * is checked again at the seam so a tool the catalog snapshot missed can
 * never run: `defaultToolPolicy` is `needs_approval`, and only
 * `always_allow` executes here.
 */
async function executeCatalogTool(
  db: Database,
  viewerUserId: string,
  binding: DataBinding,
): Promise<AppDataExecution> {
  const { mcpServers } = await buildUserMcpServers(db, viewerUserId, {
    onlyProviders: [binding.provider],
  });
  const spec = mcpServers?.[binding.provider];
  // Account providers mount over HTTP only; a missing or non-HTTP spec means
  // the viewer's mount failed (token decrypt/refresh), not a data error.
  if (!spec || !("url" in spec)) {
    return { kind: "source_error", category: "provider_mount_failed" };
  }
  const connection = await connectMcpTools(
    { [binding.provider]: spec },
    { clientName: "comparative-app-data" },
  );
  try {
    if (connection.failedProviders.length > 0) {
      return { kind: "source_error", category: "provider_unreachable" };
    }
    const tool = connection.tools.find(
      (candidate) =>
        candidate.name === mcpToolName(binding.provider, binding.toolName),
    );
    if (!tool) return { kind: "source_error", category: "tool_unavailable" };
    if (tool.policy !== "always_allow") {
      return { kind: "denied", reason: "tool_policy_not_always_allow" };
    }
    try {
      const data = await tool.handler(binding.pinnedArgs, {
        userId: viewerUserId,
      });
      return { kind: "ok", data };
    } catch {
      return { kind: "source_error", category: "tool_error" };
    }
  } finally {
    await connection.close();
  }
}
