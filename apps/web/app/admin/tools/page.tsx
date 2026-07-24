import {
  getDb,
  mcpServers,
  toolsCatalog,
  userToolAttestations,
} from "@ai-workspace/db";
import { asc, count, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { Metric, StatusBadge, titleize } from "@/app/admin/ui";
import { WebEgressPolicyForm } from "@/app/admin/tools/WebEgressPolicyForm";
import {
  loadWebEgressPolicy,
  WEB_EGRESS_SETTINGS_PROVIDER,
  WEB_EGRESS_SETTINGS_TOOL,
} from "@/lib/web-egress-policy";

export const dynamic = "force-dynamic";

export default async function AdminToolsPage() {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const db = getDb();
  const servers = await db
    .select({
      id: mcpServers.id,
      slug: mcpServers.slug,
      displayName: mcpServers.displayName,
      description: mcpServers.description,
      transport: mcpServers.transport,
      status: mcpServers.status,
      endpointUrl: mcpServers.endpointUrl,
      authMode: mcpServers.authMode,
      updatedAt: mcpServers.updatedAt,
    })
    .from(mcpServers)
    .orderBy(asc(mcpServers.displayName));

  const catalogRows = await db
    .select({
      id: toolsCatalog.id,
      provider: toolsCatalog.provider,
      toolName: toolsCatalog.toolName,
      displayName: toolsCatalog.displayName,
      description: toolsCatalog.description,
      category: toolsCatalog.category,
      action: toolsCatalog.action,
      requiresAttestation: toolsCatalog.requiresAttestation,
      enabled: toolsCatalog.enabled,
      serverSlug: mcpServers.slug,
      serverName: mcpServers.displayName,
      updatedAt: toolsCatalog.updatedAt,
    })
    .from(toolsCatalog)
    .leftJoin(mcpServers, eq(toolsCatalog.mcpServerId, mcpServers.id))
    .orderBy(
      asc(toolsCatalog.provider),
      asc(toolsCatalog.category),
      asc(toolsCatalog.displayName),
    );
  const tools = catalogRows.filter(
    (tool) =>
      !(
        tool.provider === WEB_EGRESS_SETTINGS_PROVIDER &&
        tool.toolName === WEB_EGRESS_SETTINGS_TOOL
      ),
  );
  const webEgressPolicy = await loadWebEgressPolicy(db);

  const attestationRows = await db
    .select({
      provider: userToolAttestations.provider,
      approvals: count(userToolAttestations.id),
    })
    .from(userToolAttestations)
    .where(isNull(userToolAttestations.revokedAt))
    .groupBy(userToolAttestations.provider);
  const activeApprovalsByProvider = new Map(
    attestationRows.map((row) => [row.provider, row.approvals]),
  );

  const enabledTools = tools.filter((tool) => tool.enabled).length;
  const writeTools = tools.filter((tool) => tool.action !== "read").length;
  const attestedTools = tools.filter((tool) => tool.requiresAttestation).length;

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Tools</h2>
        <p className="mt-1 text-xs text-muted">
          Registered MCP servers and the tool catalog that users can expose to
          agents.
        </p>
      </div>

      <div className="grid gap-3 px-6 pb-5 md:grid-cols-4">
        <Metric label="Servers" value={servers.length} variant="prominent" />
        <Metric
          label="Cataloged tools"
          value={tools.length}
          variant="prominent"
        />
        <Metric
          label="Enabled tools"
          value={enabledTools}
          variant="prominent"
        />
        <Metric
          label="Require approval"
          value={attestedTools}
          variant="prominent"
        />
      </div>

      <WebEgressPolicyForm
        initialDeniedDomains={webEgressPolicy.deniedDomains}
      />

      <section className="pb-6">
        <div className="px-6 pb-2">
          <h3 className="text-sm font-semibold text-ink">MCP servers</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wider text-muted">
                <th className="border-b border-hairline px-6 py-2 font-medium">
                  Server
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Status
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Transport
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Auth
                </th>
                <th className="border-b border-hairline px-6 py-2 font-medium">
                  Active approvals
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="border-b border-hairline px-6 py-8 text-center text-xs text-muted"
                  >
                    No MCP servers are registered yet.
                  </td>
                </tr>
              ) : (
                servers.map((server) => (
                  <tr key={server.id} className="hover:bg-subtle/40">
                    <td className="border-b border-hairline px-6 py-3 align-top">
                      <div className="font-medium text-ink">
                        {server.displayName}
                      </div>
                      <div className="mt-1 font-mono text-xs text-muted">
                        {server.slug}
                      </div>
                      {server.description ? (
                        <div className="mt-1 max-w-2xl text-xs text-muted">
                          {server.description}
                        </div>
                      ) : null}
                      {server.endpointUrl ? (
                        <div className="mt-1 max-w-2xl truncate font-mono text-2xs text-muted">
                          {server.endpointUrl}
                        </div>
                      ) : null}
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top">
                      <StatusBadge status={server.status} />
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top text-muted">
                      {server.transport.toUpperCase()}
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top text-muted">
                      {formatAuthMode(server.authMode)}
                    </td>
                    <td className="border-b border-hairline px-6 py-3 align-top text-muted">
                      {activeApprovalsByProvider.get(server.slug) ?? 0}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pb-6">
        <div className="flex flex-wrap items-center gap-3 px-6 pb-2">
          <h3 className="text-sm font-semibold text-ink">Tool catalog</h3>
          <span className="text-xs text-muted">
            {writeTools} write/admin tools
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wider text-muted">
                <th className="border-b border-hairline px-6 py-2 font-medium">
                  Tool
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Provider
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Category
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Action
                </th>
                <th className="border-b border-hairline px-4 py-2 font-medium">
                  Approval
                </th>
                <th className="border-b border-hairline px-6 py-2 font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {tools.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="border-b border-hairline px-6 py-8 text-center text-xs text-muted"
                  >
                    No tools are cataloged yet. Seed provider tools before
                    relying on lower-level tool governance.
                  </td>
                </tr>
              ) : (
                tools.map((tool) => (
                  <tr key={tool.id} className="hover:bg-subtle/40">
                    <td className="border-b border-hairline px-6 py-3 align-top">
                      <div className="font-medium text-ink">
                        {tool.displayName}
                      </div>
                      <div className="mt-1 max-w-72 truncate font-mono text-xs text-muted">
                        {tool.toolName}
                      </div>
                      {tool.description ? (
                        <div className="mt-1 max-w-xl text-xs text-muted">
                          {tool.description}
                        </div>
                      ) : null}
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top">
                      <div className="text-ink">{titleize(tool.provider)}</div>
                      <div className="mt-1 text-xs text-muted">
                        {tool.serverName ?? "No server link"}
                      </div>
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top text-muted">
                      {titleize(tool.category)}
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top">
                      <ActionBadge action={tool.action} />
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top text-muted">
                      {tool.requiresAttestation ? "Required" : "Not required"}
                    </td>
                    <td className="border-b border-hairline px-6 py-3 align-top">
                      <EnabledBadge enabled={tool.enabled} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function ActionBadge({ action }: { action: string }) {
  const classes =
    action === "read"
      ? "bg-subtle text-muted"
      : action === "write"
        ? "bg-warning-bg text-warning"
        : "bg-danger-bg text-danger";
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-2xs uppercase tracking-wider ${classes}`}
    >
      {action}
    </span>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-2xs uppercase tracking-wider ${
        enabled ? "bg-success-bg text-success" : "bg-subtle text-muted"
      }`}
    >
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

function formatAuthMode(value: string | null): string {
  if (!value) return "Unspecified";
  if (value === "delegated_oauth") return "Delegated OAuth";
  return titleize(value);
}
