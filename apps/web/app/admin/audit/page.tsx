import { auditLog, getDb, users } from "@ai-workspace/db";
import { and, count, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  formatDateTime,
  formatDuration,
} from "@/lib/admin/run-reporting";
import {
  auditRetentionCutoff,
  resolveAuditRetentionDays,
} from "@/lib/audit-retention";
import { parseAdminDataAccessMetadata } from "@/lib/admin-data-access";
import {
  FilterPill,
  Metric,
  StatusBadge,
  StatusDot,
  titleize,
} from "@/app/admin/ui";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  "all",
  "succeeded",
  "failed",
  "denied",
  "started",
] as const;
const PROVIDER_FILTERS = ["all", "github", "ai-hub"] as const;
const ACTION_FILTERS = ["all", "admin_data_access"] as const;

interface Props {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminAuditPage({ searchParams }: Props) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const params = (await searchParams) ?? {};
  const status = parseFilter(params.status, STATUS_FILTERS, "all");
  const provider = parseFilter(params.provider, PROVIDER_FILTERS, "all");
  const action = parseFilter(params.action, ACTION_FILTERS, "all");

  const conditions: SQL[] = [];
  if (status !== "all") conditions.push(eq(auditLog.status, status));
  if (provider !== "all") conditions.push(eq(auditLog.provider, provider));
  if (action !== "all") conditions.push(eq(auditLog.actionType, action));

  const db = getDb();
  const retentionDays = resolveAuditRetentionDays();
  const retentionCutoff = auditRetentionCutoff(new Date(), retentionDays);
  const [rows, retentionRows] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        actorUserId: auditLog.actorUserId,
        actorEmail: users.email,
        actorName: users.displayName,
        actionType: auditLog.actionType,
        status: auditLog.status,
        provider: auditLog.provider,
        toolName: auditLog.toolName,
        toolCallId: auditLog.toolCallId,
        chatThreadId: auditLog.chatThreadId,
        chatMessageId: auditLog.chatMessageId,
        runId: auditLog.runId,
        error: auditLog.error,
        metadata: auditLog.metadata,
        startedAt: auditLog.startedAt,
        completedAt: auditLog.completedAt,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(100),
    db
      .select({ value: count(auditLog.id) })
      .from(auditLog)
      .where(lt(auditLog.createdAt, retentionCutoff)),
  ]);
  const retentionEligible = retentionRows[0]?.value ?? 0;
  const targetUserIds = [
    ...new Set(
      rows.flatMap((row) => {
        const access = parseAdminDataAccessMetadata(row.metadata);
        return access && isUuid(access.targetUserId)
          ? [access.targetUserId]
          : [];
      }),
    ),
  ];
  const targetUsers =
    targetUserIds.length > 0
      ? await db
          .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
          })
          .from(users)
          .where(inArray(users.id, targetUserIds))
      : [];
  const targetUserLabels = new Map(
    targetUsers.map((user) => [
      user.id,
      user.displayName
        ? `${user.displayName} (${user.email})`
        : user.email,
    ]),
  );

  const failed = rows.filter((row) => row.status === "failed").length;
  const denied = rows.filter((row) => row.status === "denied").length;

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Audit</h2>
        <p className="mt-1 text-xs text-muted">
          Recent privileged access, tool, workflow, attestation, and rate-limit
          events from the compliance ledger.
        </p>
      </div>

      <div className="grid gap-3 px-6 pb-4 md:grid-cols-4">
        <Metric label="Retention" value={`${retentionDays}d`} />
        <Metric label="Eligible to prune" value={retentionEligible} />
        <Metric label="Failed shown" value={failed} />
        <Metric label="Denied shown" value={denied} />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        <FilterPill
          href="/admin/audit"
          active={status === "all" && provider === "all" && action === "all"}
        >
          All
        </FilterPill>
        <FilterPill
          href="/admin/audit?action=admin_data_access"
          active={action === "admin_data_access"}
        >
          Admin access
        </FilterPill>
        <FilterPill
          href="/admin/audit?status=failed"
          active={status === "failed"}
        >
          Failed
        </FilterPill>
        <FilterPill
          href="/admin/audit?status=denied"
          active={status === "denied"}
        >
          Denied
        </FilterPill>
        <FilterPill
          href="/admin/audit?provider=github"
          active={provider === "github"}
        >
          GitHub
        </FilterPill>
        <FilterPill
          href="/admin/audit?provider=ai-hub"
          active={provider === "ai-hub"}
        >
          Comparative
        </FilterPill>
        <span className="ml-auto text-xs text-muted">
          {rows.length} shown
          {failed > 0 || denied > 0 ? `, ${failed} failed, ${denied} denied` : ""}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-2xs uppercase tracking-wider text-muted">
              <th className="border-b border-hairline px-6 py-2 font-medium">
                Event
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                Actor
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                Tool
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                Context
              </th>
              <th className="border-b border-hairline px-6 py-2 font-medium">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="border-b border-hairline px-6 py-10 text-center text-xs text-muted"
                >
                  No audit events match this filter.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-subtle/40">
                  <td className="border-b border-hairline px-6 py-3 align-top">
                    <div className="flex items-start gap-3">
                      <StatusDot status={row.status} className="mt-1" />
                      <div>
                        <div className="font-medium text-ink">
                          {formatAction(row.actionType)}
                        </div>
                        <div className="mt-1 text-xs text-muted">
                          {formatDateTime(row.createdAt)}
                          {row.completedAt && row.startedAt
                            ? ` - ${formatDuration(row.startedAt, row.completedAt)}`
                            : ""}
                        </div>
                        <div className="mt-1">
                          <StatusBadge status={row.status} />
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-top">
                    <div className="max-w-56 truncate text-ink">
                      {row.actorName ?? "Unknown user"}
                    </div>
                    <div className="max-w-56 truncate text-xs text-muted">
                      {row.actorEmail ?? row.actorUserId ?? "No actor"}
                    </div>
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-top">
                    <div className="text-ink">
                      {row.provider ? titleize(row.provider) : "Platform"}
                    </div>
                    <div className="mt-1 max-w-56 truncate font-mono text-xs text-muted">
                      {row.toolName ?? "n/a"}
                    </div>
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-top text-xs text-muted">
                    {row.chatThreadId ? (
                      <Link
                        href={`/chat?threadId=${row.chatThreadId}`}
                        className="text-ink underline-offset-2 hover:underline"
                      >
                        Chat thread
                      </Link>
                    ) : row.runId ? (
                      <Link
                        href={`/admin/runs/${row.runId}`}
                        className="text-ink underline-offset-2 hover:underline"
                      >
                        Run {shortId(row.runId)}
                      </Link>
                    ) : (
                      <span>System event</span>
                    )}
                    {row.toolCallId ? (
                      <div className="mt-1 font-mono">
                        {shortId(row.toolCallId)}
                      </div>
                    ) : null}
                  </td>
                  <td className="border-b border-hairline px-6 py-3 align-top">
                    {row.error ? (
                      <div className="max-w-xl whitespace-pre-wrap rounded-md border border-danger/20 bg-danger-bg px-3 py-2 font-mono text-xs text-danger">
                        {truncate(row.error, 500)}
                      </div>
                    ) : (
                      <div className="text-xs text-muted">
                        {summarizeMetadata(
                          row.metadata,
                          targetUserLabels.get(
                            parseAdminDataAccessMetadata(row.metadata)
                              ?.targetUserId ?? "",
                          ),
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function parseFilter<T extends readonly string[]>(
  value: string | string[] | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  const single = Array.isArray(value) ? value[0] : value;
  return single && allowed.includes(single) ? single : fallback;
}

function formatAction(actionType: string): string {
  if (actionType === "mcp_tool_execution") return "Tool execution";
  if (actionType === "mcp_tool_attestation") return "Tool attestation";
  if (actionType === "rate_limit") return "Rate limit";
  return actionType
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}...`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function summarizeMetadata(
  value: unknown,
  targetUserLabel?: string,
): string {
  const adminAccess = parseAdminDataAccessMetadata(value);
  if (adminAccess) {
    const count =
      adminAccess.resourceCount && adminAccess.resourceCount > 1
        ? ` (${adminAccess.resourceCount} records)`
        : "";
    const reason = adminAccess.justification
      ? ` - Reason: ${truncate(adminAccess.justification, 120)}`
      : "";
    const target = targetUserLabel
      ? `${targetUserLabel} [${shortId(adminAccess.targetUserId)}]`
      : shortId(adminAccess.targetUserId);
    return [
      `Target ${target}`,
      `${titleize(adminAccess.resourceType)} ${truncate(
        adminAccess.resourceId,
        32,
      )}${count}`,
      `${titleize(adminAccess.surface)}${reason}`,
    ].join(" - ");
  }

  if (!value || typeof value !== "object") return "No error";
  const metadata = value as Record<string, unknown>;
  const modelId = typeof metadata.modelId === "string" ? metadata.modelId : null;
  const runtime = typeof metadata.runtime === "string" ? metadata.runtime : null;
  if (modelId && runtime) return `${runtime} - ${modelId}`;
  if (runtime) return runtime;
  if (modelId) return modelId;
  return "No error";
}
