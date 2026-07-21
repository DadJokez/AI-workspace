import { getDb, runs, users } from "@ai-workspace/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { buildRuntimeV2Report } from "@/lib/admin/run-reporting";
import { FilterPill } from "@/app/admin/ui";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  "all",
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const;
const REPORT_RUN_LIMIT = 500;

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
      inputs: runs.inputs,
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
    .limit(REPORT_RUN_LIMIT);

  const running = rows.filter((row) => row.status === "running").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const succeeded = rows.filter((row) => row.status === "succeeded").length;
  const runtimeReport = buildRuntimeV2Report(rows);

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

      <section className="px-6 pb-5">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-[13px] font-semibold text-ink">
              Runtime V2 Latency
            </h3>
            <p className="mt-1 text-[12px] text-muted">
              First-token latency by lane across the latest{" "}
              {runtimeReport.rowsAnalyzed} run(s). Fast-local samples:{" "}
              {runtimeReport.fastLocalSampleCount}.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border border-hairline">
          <table className="w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Lane
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Runs
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Samples
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  p50 1st token
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  p95 1st token
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Failed
                </th>
              </tr>
            </thead>
            <tbody>
              {runtimeReport.laneLatency.map((summary) => (
                <tr key={summary.lane}>
                  <td className="border-b border-hairline px-3 py-2 font-mono text-ink">
                    {summary.lane}
                  </td>
                  <td className="border-b border-hairline px-3 py-2 text-muted">
                    {summary.runCount}
                  </td>
                  <td className="border-b border-hairline px-3 py-2 text-muted">
                    {summary.firstTokenSamples}
                  </td>
                  <td className="border-b border-hairline px-3 py-2 text-ink">
                    {formatNullableMs(summary.p50FirstTokenMs)}
                  </td>
                  <td className="border-b border-hairline px-3 py-2 text-ink">
                    {formatNullableMs(summary.p95FirstTokenMs)}
                  </td>
                  <td className="border-b border-hairline px-3 py-2 text-muted">
                    {summary.failedCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="px-6 pb-5">
        <h3 className="text-[13px] font-semibold text-ink">
          Failure Groups
        </h3>
        <p className="mt-1 text-[12px] text-muted">
          Grouped by lane, target, provider, model, and error class. Raw prompts
          and tool payloads are not shown.
        </p>
        <div className="mt-2 overflow-x-auto rounded-md border border-hairline">
          <table className="w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Count
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Lane
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Target
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Provider
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Model
                </th>
                <th className="border-b border-hairline px-3 py-2 font-medium">
                  Error class
                </th>
              </tr>
            </thead>
            <tbody>
              {runtimeReport.failureGroups.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-5 text-center text-[12px] text-muted"
                  >
                    No failed runs in this result set.
                  </td>
                </tr>
              ) : (
                runtimeReport.failureGroups.map((group) => (
                  <tr
                    key={[
                      group.lane,
                      group.runtimeTarget,
                      group.provider,
                      group.modelId,
                      group.errorClass,
                    ].join(":")}
                  >
                    <td className="border-b border-hairline px-3 py-2 text-ink">
                      {group.count}
                    </td>
                    <td className="border-b border-hairline px-3 py-2 font-mono text-muted">
                      {group.lane}
                    </td>
                    <td className="border-b border-hairline px-3 py-2 text-muted">
                      {group.runtimeTarget}
                    </td>
                    <td className="border-b border-hairline px-3 py-2 text-muted">
                      {group.provider}
                    </td>
                    <td className="border-b border-hairline px-3 py-2 text-muted">
                      {group.modelId}
                    </td>
                    <td className="border-b border-hairline px-3 py-2 text-muted">
                      {group.errorClass}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

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
                      <div className="flex flex-wrap gap-3">
                        {row.error ? (
                          <div className="max-w-xl truncate font-mono text-[12px] text-danger">
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
                        <Link
                          href={`/chat?inspectRun=${row.id}`}
                          className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
                        >
                          Open inspector
                        </Link>
                      </div>
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

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-hairline bg-surface px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-ink">{value}</div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded"
      ? "bg-success"
      : status === "failed"
        ? "bg-danger"
        : status === "running"
          ? "animate-pulse bg-info"
          : "bg-muted";
  return <span className={`mt-1 h-2.5 w-2.5 rounded-full ${color}`} />;
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === "succeeded"
      ? "bg-success-bg text-success"
      : status === "failed"
        ? "bg-danger-bg text-danger"
        : status === "running"
          ? "bg-info-bg text-info"
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

function formatNullableMs(value: number | null | undefined) {
  if (typeof value !== "number") return "n/a";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}
