# @ai-workspace/db

Drizzle schema, client, and migrations for Comparative's Postgres.

## Migrations are handwritten — do not use drizzle-kit generate

The `drizzle/meta` snapshots are intentionally frozen at `0023` while the
migration journal runs well past it. `drizzle-kit generate` / `check` diff
against those stale snapshots and **emit wrong output** — which is why the
`db:generate` and `db:check` scripts now refuse to run (#449; finding from
the 2026-07-19 self-review).

### Adding a migration

1. Write the SQL by hand: `drizzle/00NN_short_name.sql`. Keep it
   backward-compatible with the currently deployed code (expand/contract:
   additive columns nullable or defaulted; two-phase for anything breaking —
   see `docs/PRODUCTION_DEPLOYMENT.md`).
2. Append the entry to `drizzle/meta/_journal.json` (copy the previous
   entry's shape; bump `idx` and `when`).
3. Update `src/schema.ts` to match.
4. Migrations are **Rob-gated**: they land via a reviewed PR and run against
   prod by the deploy pipeline before new code serves traffic.

### Applying locally

```bash
DATABASE_URL=postgres://… pnpm --filter @ai-workspace/db db:migrate
```

`db:migrate` (`src/migrate.ts`) replays the journal and is safe to re-run;
it is what CI's scoping-integration job and the deploy pipeline both use.

### If you're tempted to regenerate the snapshots

That's a deliberate, one-time decision (regenerate 0024–current against a
clean database and verify byte-equivalent DDL), tracked in #449 — not
something to do casually, and not something `drizzle-kit` can do correctly
from the current state.
