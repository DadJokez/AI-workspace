import { getDb, runs, users } from "@ai-workspace/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionUser } from "@/lib/auth/getSessionUser";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  "all",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const;

interface Props {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

interface RunOutput {
  runtime?: string;
  runtimeTarget?: string;
  modelId?: string;
  metrics?: RunTimingMetrics;
}

interface RunTimingMetrics {
  requestToFirstTokenMs?: number;
  requestToCompletedMs?: number;
  providerToFirstTokenMs?: number;
}

export default async function AdminRunsPage({ searchParams }: Props) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const params = (await searchParams) ?? {};
  const status = parseFilter(params.status, STATUS_FILTERS, "all");
  const conditions: SQL[] = [];
  if (status !== "all") conditions.push(eq(runs.status, status));

  const db = getDb();
  const rows = await db
    .select({
      id: runs.id,
      skillSlug: runs.skillSlug,
      status: runs.status,
      triggerType: runs.triggerType,
      runtime: runs.runtime,
      modelId: runs.modelId,
      outputs: runs.outputs,
      error: runs.error,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      createdAt: runs.createdAt,
      actorEmail: users.email,
      actorName: users.displayName,
    })
    .from(runs)
    .leftJoin(users, eq(runs.userId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(100);

  const running = rows.filter((row) => row.status === "running").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const succeeded = rows.filter((row) => row.status === "succeeded").length;

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Runs</h2>
        <p className="mt-1 text-[12px] text-muted">
          Recent chat, workflow, and skill executions, including Developer
          Briefing runs.
        </p>
      </div>

      <div className="grid gap-3 px-6 pb-5 md:grid-cols-4">
        <Metric label="Shown" value={rows.length} />
        <Metric label="Succeeded" value={succeeded} />
        <Metric label="Running" value={running} />
        <Metric label="Failed" value={failed} />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        <FilterPill href="/admin/runs" active={status === "all"}>
          All
        </FilterPill>
        <FilterPill
          href="/admin/runs?status=succeeded"
          active={status === "succeeded"}
        >
          Succeeded
        </FilterPill>
        <FilterPill
          href="/admin/runs?status=running"
          active={status === "running"}
        >
          Running
        </FilterPill>
        <FilterPill
          href="/admin/runs?status=failed"
          active={status === "failed"}
        >
          Failed
        </FilterPill>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              <th className="border-b border-hairline px-6 py-2 font-medium">
                Run
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                User
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                Runtime
              </th>
              <th className="border-b border-hairline px-4 py-2 font-medium">
                Timing
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
                  No runs match this filter.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const output = parseRunOutput(row.outputs);
                return (
                  <tr key={row.id} className="hover:bg-subtle/40">
                    <td className="border-b border-hairline px-6 py-3 align-top">
                      <div className="flex items-start gap-3">
                        <StatusDot status={row.status} />
                        <div>
                          <Link
                            href={`/admin/runs/${row.id}`}
                            className="font-medium text-ink underline-offset-2 hover:underline"
                          >
                            {formatSkill(row.skillSlug)}
                          </Link>
                          <div className="mt-1 font-mono text-[12px] text-muted">
                            {shortId(row.id)}
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
                        {row.actorEmail ?? "No email"}
                      </div>
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top">
                      <div className="text-ink">
                        {output.runtime ?? row.runtime ?? "n/a"}
                      </div>
                      <div className="mt-1 max-w-56 truncate text-[12px] text-muted">
                        {output.runtimeTarget ?? "target n/a"}
                      </div>
                      <div className="mt-1 max-w-56 truncate text-[12px] text-muted">
                        {output.modelId ?? row.modelId ?? "No model"}
                      </div>
                    </td>
                    <td className="border-b border-hairline px-4 py-3 align-top text-[12px] text-muted">
                      <div>{formatDateTime(row.createdAt)}</div>
                      <div className="mt-1">
                        {row.startedAt && row.completedAt
                          ? formatDuration(row.startedAt, row.completedAt)
                          : row.startedAt
                            ? "In progress"
                            : "Not started"}
                      </div>
                      <div className="mt-1 text-ink">
                        1st token:{" "}
                        {formatNullableMs(
                          output.metrics?.requestToFirstTokenMs,
                        )}
                      </div>
                    </td>
                    <td className="border-b border-hairline px-6 py-3 align-top">
                      {row.error ? (
                        <div className="max-w-xl truncate font-mono text-[12px] text-red-300">
                          {row.error}
                        </div>
                      ) : (
                        <Link
                          href={`/admin/runs/${row.id}`}
                          className="text-[12px] text-ink underline-offset-2 hover:underline"
                        >
                          View run
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-hairline bg-surface px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
    </div>
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
        : status === "running"
          ? "animate-pulse bg-blue-400"
          : "bg-muted";
  return <span className={`mt-1 h-2.5 w-2.5 rounded-full ${color}`} />;
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === "succeeded"
      ? "bg-green-400/10 text-green-300"
      : status === "failed"
        ? "bg-red-400/10 text-red-300"
        : status === "running"
          ? "bg-blue-400/10 text-blue-300"
          : "bg-subtle text-muted";
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-[11px] uppercase tracking-wider ${classes}`}
    >
      {status}
    </span>
  );
}

function parseRunOutput(value: unknown): RunOutput {
  if (!isRecord(value)) return {};
  return {
    runtime: typeof value.runtime === "string" ? value.runtime : undefined,
    runtimeTarget:
      typeof value.runtimeTarget === "string" ? value.runtimeTarget : undefined,
    modelId: typeof value.modelId === "string" ? value.modelId : undefined,
    metrics: parseRunTimingMetrics(value.metrics),
  };
}

function parseRunTimingMetrics(value: unknown): RunTimingMetrics | undefined {
  if (!isRecord(value)) return undefined;
  return {
    requestToFirstTokenMs:
      typeof value.requestToFirstTokenMs === "number"
        ? value.requestToFirstTokenMs
        : undefined,
    requestToCompletedMs:
      typeof value.requestToCompletedMs === "number"
        ? value.requestToCompletedMs
        : undefined,
    providerToFirstTokenMs:
      typeof value.providerToFirstTokenMs === "number"
        ? value.providerToFirstTokenMs
        : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFilter<T extends readonly string[]>(
  value: string | string[] | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  const single = Array.isArray(value) ? value[0] : value;
  return single && allowed.includes(single) ? single : fallback;
}

function formatSkill(value: string | null) {
  if (value === "developer-briefing") return "Developer Briefing";
  return value
    ? value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
    : "Workflow run";
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatDuration(startedAt: Date, completedAt: Date) {
  const ms = Math.max(0, completedAt.getTime() - startedAt.getTime());
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatNullableMs(value: number | undefined) {
  if (typeof value !== "number") return "n/a";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}
