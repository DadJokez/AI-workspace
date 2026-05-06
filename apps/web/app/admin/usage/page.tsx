export const dynamic = "force-dynamic";

// `usage_events` lives on a separate branch that hasn't merged yet. Once it
// does, this page reads from that table and renders requests-by-user,
// requests-by-model, and requests-by-day for a 7d / 30d / 90d window —
// reusing the chart pieces we already have in SettingsPanel scoped to all
// users (admin role bypasses the usual per-user scope predicate).
export default function AdminUsagePage() {
  return (
    <section className="px-6 py-10">
      <div className="mx-auto max-w-md rounded-lg border border-hairline bg-surface px-6 py-8 text-center">
        <h2 className="text-base font-semibold text-ink">Usage</h2>
        <p className="mt-2 text-[13px] text-muted">
          Coming soon. Workspace-wide usage rollups (requests by user, model,
          and day) light up once the <code>usage_events</code> table lands.
        </p>
        <div className="mt-4 inline-flex items-center rounded bg-subtle px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted">
          Awaiting usage_events branch
        </div>
      </div>
    </section>
  );
}
