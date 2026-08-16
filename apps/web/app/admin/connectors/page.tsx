import {
  auditLog,
  getDb,
  mcpServers,
  oauthTokens,
  toolsCatalog,
  users,
  userToolAttestations,
} from "@ai-workspace/db";
import { asc, desc, eq, inArray, max } from "drizzle-orm";
import { redirect } from "next/navigation";
import { FilterPill, Metric, StatusBadge, titleize } from "@/app/admin/ui";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { formatDateTime } from "@/lib/admin/run-reporting";
import {
  ConnectionRevokeControl,
  ConnectorControls,
  ToolPolicyControls,
} from "./ConnectorControls";

export const dynamic = "force-dynamic";

const VIEWS = ["connectors", "connections", "decisions"] as const;
type View = (typeof VIEWS)[number];
const LIFECYCLE_ACTIONS = [
  "connector.enabled",
  "connector.disabled",
  "connector.updated",
  "connector.tool_policy_updated",
  "connection.granted",
  "connection.revoked",
  "attestation.granted",
  "attestation.revoked",
  "user.deprovisioned",
] as const;

export default async function AdminConnectorsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") redirect("/chat");
  const params = (await searchParams) ?? {};
  const rawView = Array.isArray(params.view) ? params.view[0] : params.view;
  const view: View = VIEWS.includes(rawView as View)
    ? (rawView as View)
    : "connectors";

  const db = getDb();
  const [serverRows, catalogRows, userRows, connectionRows, attestationRows, usageRows, decisionRows] =
    await Promise.all([
      db.select().from(mcpServers).orderBy(asc(mcpServers.displayName)),
      db
        .select()
        .from(toolsCatalog)
        .orderBy(asc(toolsCatalog.provider), asc(toolsCatalog.displayName)),
      db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .orderBy(asc(users.displayName)),
      db
        .select({
          id: oauthTokens.id,
          userId: oauthTokens.userId,
          provider: oauthTokens.provider,
          scope: oauthTokens.scope,
          grantedAt: oauthTokens.grantedAt,
          revokedAt: oauthTokens.revokedAt,
          revokedBy: oauthTokens.revokedBy,
          revocationReason: oauthTokens.revocationReason,
          updatedAt: oauthTokens.updatedAt,
        })
        .from(oauthTokens)
        .orderBy(desc(oauthTokens.updatedAt)),
      db
        .select({
          id: userToolAttestations.id,
          userId: userToolAttestations.userId,
          provider: userToolAttestations.provider,
          scopeType: userToolAttestations.scopeType,
          category: userToolAttestations.category,
          toolName: userToolAttestations.toolName,
          action: userToolAttestations.action,
          approvedAt: userToolAttestations.approvedAt,
          approvedBy: userToolAttestations.approvedBy,
          revokedAt: userToolAttestations.revokedAt,
          revokedBy: userToolAttestations.revokedBy,
          revocationReason: userToolAttestations.revocationReason,
        })
        .from(userToolAttestations)
        .orderBy(desc(userToolAttestations.updatedAt)),
      db
        .select({
          userId: auditLog.actorUserId,
          provider: auditLog.provider,
          lastUsedAt: max(auditLog.createdAt),
        })
        .from(auditLog)
        .where(eq(auditLog.actionType, "mcp_tool_execution"))
        .groupBy(auditLog.actorUserId, auditLog.provider),
      db
        .select({
          id: auditLog.id,
          actorUserId: auditLog.actorUserId,
          actionType: auditLog.actionType,
          status: auditLog.status,
          provider: auditLog.provider,
          toolName: auditLog.toolName,
          input: auditLog.input,
          metadata: auditLog.metadata,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(inArray(auditLog.actionType, [...LIFECYCLE_ACTIONS]))
        .orderBy(desc(auditLog.createdAt))
        .limit(200),
    ]);

  const userLabels = new Map(
    userRows.map((user) => [
      user.id,
      user.displayName ? `${user.displayName} (${user.email})` : user.email,
    ]),
  );
  const toolsByServer = groupCounts(
    catalogRows.filter((tool) => tool.mcpServerId),
    (tool) => tool.mcpServerId!,
  );
  const activeToolsByServer = groupCounts(
    catalogRows.filter((tool) => tool.mcpServerId && tool.enabled),
    (tool) => tool.mcpServerId!,
  );
  const activeConnections = connectionRows.filter((row) => !row.revokedAt);
  const connectionsByProvider = groupCounts(activeConnections, (row) => row.provider);
  const lastUsedByConnection = new Map(
    usageRows.map((row) => [`${row.userId}:${row.provider}`, row.lastUsedAt]),
  );
  const attestationsByConnection = groupRows(
    attestationRows,
    (row) => `${row.userId}:${row.provider}`,
  );
  const activeServers = serverRows.filter((server) => server.status === "active").length;

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Connectors</h2>
        <p className="mt-1 text-xs text-muted">
          Organization connector policy, delegated account grants, and lifecycle decisions.
        </p>
      </div>

      <div className="grid gap-3 px-6 pb-4 md:grid-cols-4">
        <Metric label="Active connectors" value={activeServers} />
        <Metric label="Active connections" value={activeConnections.length} />
        <Metric label="Cataloged tools" value={catalogRows.length} />
        <Metric label="Lifecycle events" value={decisionRows.length} />
      </div>

      <div className="flex flex-wrap gap-2 px-6 pb-4">
        <FilterPill href="/admin/connectors?view=connectors" active={view === "connectors"}>
          Connectors
        </FilterPill>
        <FilterPill href="/admin/connectors?view=connections" active={view === "connections"}>
          Connections
        </FilterPill>
        <FilterPill href="/admin/connectors?view=decisions" active={view === "decisions"}>
          Decisions
        </FilterPill>
      </div>

      {view === "connectors" ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wider text-muted">
                  <Header>Connector</Header>
                  <Header>Governance</Header>
                  <Header>Inventory</Header>
                  <Header>Controls</Header>
                </tr>
              </thead>
              <tbody>
                {serverRows.map((server) => (
                  <tr key={server.id} className="hover:bg-subtle/40">
                    <Cell first>
                      <div className="font-medium text-ink">{server.displayName}</div>
                      <div className="mt-1 font-mono text-xs text-muted">{server.slug}</div>
                      <div className="mt-2"><StatusBadge status={server.status} /></div>
                    </Cell>
                    <Cell>
                      <div className="text-ink">
                        {server.ownerUserId ? userLabels.get(server.ownerUserId) ?? "Unknown owner" : "Unassigned owner"}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {server.credentialType ?? server.authMode ?? "Credential type unset"}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        TTL {formatTtl(server.credentialTtlSeconds)} · rotated {formatOptionalDate(server.lastRotatedAt)}
                      </div>
                    </Cell>
                    <Cell>
                      <div className="text-ink">
                        {activeToolsByServer.get(server.id) ?? 0}/{toolsByServer.get(server.id) ?? 0} tools enabled
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {connectionsByProvider.get(server.slug) ?? 0} connected users
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {server.status === "active" ? `Enabled ${formatOptionalDate(server.enabledAt)}` : `Disabled ${formatOptionalDate(server.disabledAt)}`}
                      </div>
                    </Cell>
                    <Cell>
                      <ConnectorControls
                        connector={{
                          id: server.id,
                          status: server.status,
                          ownerUserId: server.ownerUserId,
                          credentialType: server.credentialType,
                          credentialTtlSeconds: server.credentialTtlSeconds,
                          lastRotatedAt: server.lastRotatedAt?.toISOString() ?? null,
                        }}
                        owners={userRows.map((user) => ({ id: user.id, label: userLabels.get(user.id)! }))}
                      />
                    </Cell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="border-t border-hairline pt-5">
            <div className="px-6 pb-2">
              <h3 className="text-sm font-semibold text-ink">Tool policy</h3>
              <p className="mt-1 text-xs text-muted">
                Runtime policy is loaded from these catalog rows on every governed turn.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wider text-muted">
                    <Header>Tool</Header>
                    <Header>Action</Header>
                    <Header>Current policy</Header>
                    <Header>Controls</Header>
                  </tr>
                </thead>
                <tbody>
                  {catalogRows.map((tool) => (
                    <tr key={tool.id} className="hover:bg-subtle/40">
                      <Cell first>
                        <div className="font-medium text-ink">{tool.displayName}</div>
                        <div className="mt-1 font-mono text-xs text-muted">{tool.provider}__{tool.toolName}</div>
                      </Cell>
                      <Cell>{titleize(tool.action)}</Cell>
                      <Cell>
                        <StatusBadge status={tool.enabled ? tool.policy : "disabled"} label={tool.enabled ? titleize(tool.policy) : "Disabled"} />
                      </Cell>
                      <Cell>
                        <ToolPolicyControls tool={{ id: tool.id, policy: tool.policy, enabled: tool.enabled }} />
                      </Cell>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {view === "connections" ? (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wider text-muted">
                <Header>User / provider</Header>
                <Header>Grant</Header>
                <Header>Attestation</Header>
                <Header>Last used</Header>
                <Header>Revocation</Header>
              </tr>
            </thead>
            <tbody>
              {connectionRows.map((connection) => {
                const key = `${connection.userId}:${connection.provider}`;
                const grants = attestationsByConnection.get(key) ?? [];
                const activeGrants = grants.filter((grant) => !grant.revokedAt);
                return (
                  <tr key={connection.id} className="hover:bg-subtle/40">
                    <Cell first>
                      <div className="font-medium text-ink">{userLabels.get(connection.userId) ?? connection.userId}</div>
                      <div className="mt-1 text-xs text-muted">{titleize(connection.provider)}</div>
                    </Cell>
                    <Cell>
                      <StatusBadge status={connection.revokedAt ? "revoked" : "active"} />
                      <div className="mt-1 text-xs text-muted">Granted {formatOptionalDate(connection.grantedAt)}</div>
                      <div className="mt-1 max-w-64 truncate text-xs text-muted" title={connection.scope ?? undefined}>{connection.scope ?? "Scope not recorded"}</div>
                    </Cell>
                    <Cell>
                      {activeGrants.length > 0 ? activeGrants.map((grant) => (
                        <div key={grant.id} className="text-xs text-muted">
                          {grant.scopeType}{grant.category ? `:${grant.category}` : ""}{grant.toolName ? `:${grant.toolName}` : ""} · {grant.action}
                        </div>
                      )) : <span className="text-xs text-muted">No active grant</span>}
                    </Cell>
                    <Cell>{formatOptionalDate(lastUsedByConnection.get(key) ?? null)}</Cell>
                    <Cell>
                      {connection.revokedAt ? (
                        <div className="max-w-80 text-xs text-muted">
                          {formatOptionalDate(connection.revokedAt)} by {connection.revokedBy ? userLabels.get(connection.revokedBy) ?? "Unknown actor" : "Unknown actor"}
                          <div className="mt-1 text-ink">{connection.revocationReason ?? "No reason recorded"}</div>
                        </div>
                      ) : (
                        <ConnectionRevokeControl connectionId={connection.id} />
                      )}
                    </Cell>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {view === "decisions" ? (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wider text-muted">
                <Header>Decision</Header>
                <Header>Actor</Header>
                <Header>Subject</Header>
                <Header>Reason / detail</Header>
              </tr>
            </thead>
            <tbody>
              {decisionRows.map((decision) => (
                <tr key={decision.id} className="hover:bg-subtle/40">
                  <Cell first>
                    <div className="font-medium text-ink">{titleize(decision.actionType)}</div>
                    <div className="mt-1 text-xs text-muted">{formatDateTime(decision.createdAt)}</div>
                  </Cell>
                  <Cell>{decision.actorUserId ? userLabels.get(decision.actorUserId) ?? decision.actorUserId : "System"}</Cell>
                  <Cell>
                    <div className="text-ink">{decision.provider ? titleize(decision.provider) : "Platform"}</div>
                    <div className="mt-1 font-mono text-xs text-muted">{decision.toolName ?? "n/a"}</div>
                  </Cell>
                  <Cell>
                    <pre className="max-w-xl whitespace-pre-wrap break-words font-mono text-xs text-muted">
                      {formatDecisionDetail(decision.metadata, decision.input)}
                    </pre>
                  </Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function Header({ children }: { children: React.ReactNode }) {
  return <th className="border-b border-hairline px-4 py-2 font-medium first:pl-6 last:pr-6">{children}</th>;
}

function Cell({ children, first = false }: { children: React.ReactNode; first?: boolean }) {
  return <td className={`border-b border-hairline px-4 py-3 align-top text-muted ${first ? "pl-6" : ""}`}>{children}</td>;
}

function groupCounts<T>(rows: readonly T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return counts;
}

function groupRows<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return grouped;
}

function formatTtl(seconds: number | null): string {
  if (!seconds) return "unset";
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round((seconds / 86_400) * 10) / 10}d`;
}

function formatOptionalDate(value: Date | string | null): string {
  if (!value) return "never";
  return formatDateTime(value instanceof Date ? value : new Date(value));
}

function formatDecisionDetail(metadata: unknown, input: unknown): string {
  const value = metadata ?? input ?? {};
  const text = JSON.stringify(value, null, 2);
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}
