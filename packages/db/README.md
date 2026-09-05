# @ai-workspace/db

Drizzle schema, client, and migrations for Comparative's Postgres.

## Migrations are handwritten — do not use drizzle-kit generate

The `drizzle/meta` snapshots are intentionally frozen at `0023` while the
migration journal runs well past it. `drizzle-kit generate` / `check` diff
against those stale snapshots and **emit wrong output** — which is why the
`db:generate` and `db:check` scripts now refuse to run (#449; finding from
the 2026-07-19 self-review).

### Adding a migration

1. Write the SQL by hand: `drizzle/00NN_short_name.sql`. Keep it **additive**
   and backward-compatible with the currently deployed code (expand/contract:
   new tables, nullable or defaulted columns, new indexes; two-phase for
   anything breaking — see `docs/PRODUCTION_DEPLOYMENT.md`).
2. Append the entry to `drizzle/meta/_journal.json` (copy the previous
   entry's shape). `idx` is the previous `idx` + 1 and matches the `00NN`
   prefix; `when` must be **greater than the previous entry's** — the
   migrator applies only entries whose `when` exceeds the last applied one,
   so a lower `when` passes CI from an empty database and silently never
   runs in prod.
3. Update `src/schema.ts` to match.
4. Run `pnpm --filter @ai-workspace/db migration:guard` (below); CI runs the
   same check on every PR.
5. Migrations are **Rob-gated**: they land via a reviewed PR and run against
   prod by the deploy pipeline before new code serves traffic.

### The migration guard

`scripts/migration-guard.mjs` (`pnpm --filter @ai-workspace/db migration:guard`;
Node stdlib only, runs in milliseconds) makes the two rules above mechanical
(#898). On every run it checks the journal over the whole folder: one entry
per `NNNN_*.sql` whose `tag` is the file stem, `idx` contiguous from 0 and
equal to the `NNNN` prefix, `when` strictly increasing. On the migrations
**added or changed since `--base`** (default `origin/main`; uncommitted and
untracked files count) it fails any statement on the deny list:

`DROP TABLE`, `DROP COLUMN`, `DROP INDEX`, `RENAME`, `ALTER TYPE`,
`ALTER COLUMN … TYPE`, `SET NOT NULL`, `TRUNCATE`, `DELETE FROM`, `UPDATE`
(a data migration is not additive; `ON UPDATE` FK actions and
`ON CONFLICT DO UPDATE` upserts do not count).

A statement that genuinely has to be on that list is excused by a comment
directly above it:

```sql
-- migration-guard-allow: is_admin was replaced by role above; nothing reads it after #NNN
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_admin";
```

One marker excuses exactly one statement, the reason is mandatory, and a
marker with no denied statement after it is stale and fails — exceptions
cannot rot (same shape as `// scoping-guard-allow:`, #858). A marked
statement is not a guard failure; it is the reviewer's cue to route the PR
to Rob (`needs-rob`, #891). The guard splits statements on `;` outside
strings, comments and `$$` bodies rather than parsing SQL — enough for this
deny list, not a validator. `--census` prints every match across history
without failing; `scripts/migration-guard.test.ts` pins that list, so a rule
change that would have judged history differently shows up as a test diff.

### Fail-fast timeouts

`db:migrate` sets `lock_timeout = '10s'` and `statement_timeout = '5min'` on
its single connection before drizzle's migration transaction opens
(`src/apply-migrations.ts`). Without them a DDL statement queued behind a
long-running transaction holds its lock request open — stalling every later
query on that table — until CodeBuild's 30-minute cap kills the build. With
them the migrator exits non-zero naming the timeout and the migration tag,
the transaction rolls back, and the deploy aborts before anything rolls. A
statement that legitimately needs more than five minutes is a batched,
two-phase migration, not a deploy step. (`MIGRATE_LOCK_TIMEOUT` /
`MIGRATE_STATEMENT_TIMEOUT` override the values for tests only.)

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
