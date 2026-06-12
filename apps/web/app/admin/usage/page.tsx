import { MODELS, isValidModelId } from "@ai-workspace/agent";
import { getDb, runs, users } from "@ai-workspace/db";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  USAGE_WINDOWS,
  buildDaySeries,
  parseUsageWindow,
  percent,
  windowSince,
  type UsageWindow,
} from "@/lib/usage-analytics";

export const dynamic = "force-dynamic";

interface Props {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

const WINDOW_LABELS: Record<UsageWindow, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

/**
 * Workspace-wide adoption analytics, aggregated from the `runs` ledger over a
 * trailing window. Admin-only. This is the screen an exec leans into and the
 * evidence an IT reviewer wants: who is using it, how much, with which models,
 * and whether it is succeeding.
 */
export default async function AdminUsagePage({ searchParams }: Props) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const params = (await searchParams) ?? {};
  const range = parseUsageWindow(params.window);
  const now = new Date();
  const since = windowSince(range, now);
  const sinceCondition = gte(runs.createdAt, since);

  const db = getDb();

  const totalsRows = await db
    .select({
      total: sql<number>`count(*)::int`,
      activeUsers: sql<number>`count(distinct ${runs.userId})::int`,
      succeeded: sql<number>`(count(*) filter (where ${runs.status} = 'succeeded'))::int`,
      failed: sql<number>`(count(*) filter (where ${runs.status} = 'failed'))::int`,
      chatTurns: sql<number>`(count(*) filter (where ${runs.triggerType} = 'chat'))::int`,
    })
    .from(runs)
    .where(sinceCondition);
  const totals = totalsRows[0] ?? {
    total: 0,
    activeUsers: 0,
    succeeded: 0,
    failed: 0,
    chatTurns: 0,
  };

  const dayRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${runs.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(runs)
    .where(sinceCondition)
    .groupBy(sql`date_trunc('day', ${runs.createdAt} at time zone 'UTC')`);
  const series = buildDaySeries(dayRows, range, now);
  const maxDay = Math.max(1, ...series.map((d) => d.count));

  const byModel = await db
    .select({ modelId: runs.modelId, count: sql<number>`count(*)::int` })
    .from(runs)
    .where(sinceCondition)
    .groupBy(runs.modelId)
    .orderBy(desc(sql`count(*)`));

  const byTrigger = await db
    .select({
      triggerType: runs.triggerType,
      count: sql<number>`count(*)::int`,
    })
    .from(runs)
    .where(sinceCondition)
    .groupBy(runs.triggerType)
    .orderBy(desc(sql`count(*)`));

  const topUsers = await db
    .select({
      userId: runs.userId,
      name: users.displayName,
      email: users.email,
      count: sql<number>`count(*)::int`,
    })
    .from(runs)
    .leftJoin(users, eq(runs.userId, users.id))
    .where(and(sinceCondition, isNotNull(runs.userId)))
    .groupBy(runs.userId, users.displayName, users.email)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  const successRate = percent(totals.succeeded, totals.total);

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Usage</h2>
        <p className="mt-1 text-[12px] text-muted">
          Workspace-wide adoption over the last {WINDOW_LABELS[range]}, from the
          run ledger. Every chat turn, skill, and scheduled run counts.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        {USAGE_WINDOWS.map((w) => (
          <FilterPill key={w} href={`/admin/usage?window=${w}`} active={range === w}>
            {WINDOW_LABELS[w]}
          </FilterPill>
        ))}
        <span className="ml-auto text-[12px] text-muted">
          since {since.toISOString().slice(0, 10)}
        </span>
      </div>

      <div className="grid gap-3 px-6 pb-5 md:grid-cols-4">
        <Metric label="Total runs" value={totals.total.toLocaleString()} />
        <Metric label="Active users" value={totals.activeUsers.toLocaleString()} />
        <Metric
          label="Success rate"
          value={totals.total > 0 ? `${successRate}%` : "—"}
          hint={`${totals.succeeded.toLocaleString()} ok · ${totals.failed.toLocaleString()} failed`}
        />
        <Metric label="Chat turns" value={totals.chatTurns.toLocaleString()} />
      </div>

      <div className="px-6 pb-6">
        <div className="rounded-lg border border-hairline bg-surface p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-[13px] font-medium text-ink">Runs per day</h3>
            <span className="text-[11px] uppercase tracking-wider text-muted">
              peak {maxDay.toLocaleString()}/day
            </span>
          </div>
          {totals.total === 0 ? (
            <EmptyHint>No runs in this window yet.</EmptyHint>
          ) : (
            <div className="flex h-32 items-end gap-px border-b border-hairline">
              {series.map((d) => (
                <div
                  key={d.day}
                  className="group flex flex-1 items-end"
                  style={{ minWidth: "2px" }}
                  title={`${d.day}: ${d.count.toLocaleString()} run${d.count === 1 ? "" : "s"}`}
                >
                  <div
                    className="w-full rounded-sm bg-ink/70 transition-colors group-hover:bg-ink"
                    style={{
                      height: `${Math.max(d.count === 0 ? 0 : 4, (d.count / maxDay) * 100)}%`,
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 px-6 pb-6 md:grid-cols-2">
        <Panel title="By model">
          {byModel.length === 0 ? (
            <EmptyHint>No model usage yet.</EmptyHint>
          ) : (
            byModel.map((m) => (
              <BarRow
                key={m.modelId ?? "unknown"}
                label={formatModel(m.modelId)}
                count={m.count}
                total={totals.total}
              />
            ))
          )}
        </Panel>
        <Panel title="By trigger">
          {byTrigger.length === 0 ? (
            <EmptyHint>No runs yet.</EmptyHint>
          ) : (
            byTrigger.map((t) => (
              <BarRow
                key={t.triggerType}
                label={titleize(t.triggerType)}
                count={t.count}
                total={totals.total}
              />
            ))
          )}
        </Panel>
      </div>

      <div className="px-6 pb-10">
        <Panel title="Most active users">
          {topUsers.length === 0 ? (
            <EmptyHint>No attributed runs yet.</EmptyHint>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {topUsers.map((u, i) => (
                  <tr key={u.userId} className="border-b border-hairline last:border-0">
                    <td className="py-2 pr-2 text-[12px] text-muted">{i + 1}</td>
                    <td className="py-2 pr-4">
                      <div className="text-ink">{u.name ?? "Unknown user"}</div>
                      <div className="text-[12px] text-muted">{u.email ?? "—"}</div>
                    </td>
                    <td className="py-2 text-right font-medium text-ink">
                      {u.count.toLocaleString()}
                      <span className="ml-1 text-[12px] font-normal text-muted">
                        ({percent(u.count, totals.total)}%)
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-surface px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {hint ? <div className="mt-1 text-[12px] text-muted">{hint}</div> : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-hairline bg-surface p-4">
      <h3 className="mb-3 text-[13px] font-medium text-ink">{title}</h3>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

function BarRow({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const pct = percent(count, total);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-ink">{label}</span>
        <span className="text-[12px] text-muted">
          {count.toLocaleString()} · {pct}%
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-subtle">
        <div
          className="h-full rounded bg-ink/60"
          style={{ width: `${Math.max(pct === 0 ? 0 : 2, pct)}%` }}
        />
      </div>
    </div>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-[12px] text-muted">{children}</div>;
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

function formatModel(modelId: string | null): string {
  if (!modelId) return "Unspecified";
  if (isValidModelId(modelId)) return MODELS[modelId].displayName;
  return modelId;
}

function titleize(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
