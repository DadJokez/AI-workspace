import { auditLog, getDb, users } from "@ai-workspace/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionUser } from "@/lib/auth/getSessionUser";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  "all",
  "succeeded",
  "failed",
  "denied",
  "started",
] as const;
const PROVIDER_FILTERS = ["all", "github", "ai-hub"] as const;

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

  const conditions: SQL[] = [];
  if (status !== "all") conditions.push(eq(auditLog.status, status));
  if (provider !== "all") conditions.push(eq(auditLog.provider, provider));

  const db = getDb();
  const rows = await db
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
      recipeRunId: auditLog.recipeRunId,
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
    .limit(100);

  const failed = rows.filter((row) => row.status === "failed").length;
  const denied = rows.filter((row) => row.status === "denied").length;

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Audit</h2>
        <p className="mt-1 text-[12px] text-muted">
          Recent tool, workflow, attestation, and rate-limit events from the
          compliance ledger.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        <FilterPill
          href="/admin/audit"
          active={status === "all" && provider === "all"}
        >
          All
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
          AI Hub
        </FilterPill>
        <span className="ml-auto text-[12px] text-muted">
          {rows.length} shown
          {failed > 0 || denied > 0 ? `, ${failed} failed, ${denied} denied` : ""}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="border-b border-hairline px-6 py-2 font-medium">
                Event
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                User
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
                  className="border-b border-hairline px-6 py-10 text-center text-[12px] text-muted"
                >
                  No audit events match this filter.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-subtle/40">
                  <td className="border-b border-hairline px-6 py-3 align-top">
                    <div className="flex items-start gap-3">
                      <StatusDot status={row.status} />
                      <div>
                        <div className="font-medium text-ink">
                          {formatAction(row.actionType)}
                        </div>
                        <div className="mt-1 text-[12px] text-muted">
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
                    <div className="max-w-56 truncate text-[12px] text-muted">
                      {row.actorEmail ?? row.actorUserId ?? "No actor"}
                    </div>
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-top">
                    <div className="text-ink">
                      {row.provider ? titleize(row.provider) : "Platform"}
                    </div>
                    <div className="mt-1 max-w-56 truncate font-mono text-[12px] text-muted">
                      {row.toolName ?? "n/a"}
                    </div>
                  </td>
                  <td className="border-b border-hairline px-4 py-3 align-top text-[12px] text-muted">
                    {row.chatThreadId ? (
                      <Link
                        href={`/chat?threadId=${row.chatThreadId}`}
                        className="text-ink underline-offset-2 hover:underline"
                      >
                        Chat thread
                      </Link>
                    ) : row.recipeRunId ? (
                      <Link
                        href={`/admin/runs/${row.recipeRunId}`}
                        className="text-ink underline-offset-2 hover:underline"
                      >
                        Recipe run {shortId(row.recipeRunId)}
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
                      <div className="max-w-xl whitespace-pre-wrap rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-[12px] text-red-300">
                        {truncate(row.error, 500)}
                      </div>
                    ) : (
                      <div className="text-[12px] text-muted">
                        {summarizeMetadata(row.metadata)}
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

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-md border px-2.5 py-1 text-[12px] ${
        active
          ? "border-ink bg-ink text-canvas"
          : "border-hairline text-muted hover:bg-subtle hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded"
      ? "bg-green-400"
      : status === "failed"
        ? "bg-red-400"
        : status === "denied"
          ? "bg-yellow-400"
          : "bg-muted";
  return <span className={`mt-1 h-2.5 w-2.5 rounded-full ${color}`} />;
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === "succeeded"
      ? "bg-green-400/10 text-green-300"
      : status === "failed"
        ? "bg-red-400/10 text-red-300"
        : status === "denied"
          ? "bg-yellow-400/10 text-yellow-300"
          : "bg-subtle text-muted";
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-[11px] uppercase tracking-wider ${classes}`}
    >
      {status}
    </span>
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

function titleize(value: string): string {
  if (value.toLowerCase() === "github") return "GitHub";
  if (value.toLowerCase() === "ai-hub") return "AI Hub";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatDuration(startedAt: Date, completedAt: Date): string {
  const ms = Math.max(0, completedAt.getTime() - startedAt.getTime());
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}...`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function summarizeMetadata(value: unknown): string {
  if (!value || typeof value !== "object") return "No error";
  const metadata = value as Record<string, unknown>;
  const modelId = typeof metadata.modelId === "string" ? metadata.modelId : null;
  const runtime = typeof metadata.runtime === "string" ? metadata.runtime : null;
  if (modelId && runtime) return `${runtime} - ${modelId}`;
  if (runtime) return runtime;
  if (modelId) return modelId;
  return "No error";
}
