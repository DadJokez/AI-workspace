# ADR 0008: Handwritten SQL migrations over drizzle-kit generate

- **Status:** Accepted
- **Date:** 2026-07-19
- **Deciders:** Rob (owner), Claude/Codex (implementation)

## Context
The `@ai-workspace/db` package uses Drizzle, whose default workflow is `drizzle-kit generate` — diffing `src/schema.ts` against a stored meta snapshot to emit migration DDL. That workflow depends on the meta snapshots staying in sync, but they have not: `packages/db/drizzle/meta/` holds snapshots only through `0023_snapshot.json` (with 0013 and 0015–0019 also missing), while `packages/db/drizzle/meta/_journal.json` is hand-maintained out to idx 35 (`0035_salesforce_tools_catalog`) — a ~12-migration drift confirmed in `docs/reviews/REPO-SELF-REVIEW-2026-07-19.md:178-181,252-255`. Against a frozen 0023 snapshot, `db:generate` would re-emit DDL for already-applied objects (recommendations, feedback_reports, notifications, model_enablement, …). Separately, migrations are a human-owned gate here (`AGENTS.md:22-24`; `CLAUDE.md` review priority 7), so raw SQL that a human can read line-by-line is the intended review surface, not a generated diff.

## Decision
Migrations are authored by hand as raw `.sql` files in `packages/db/drizzle/` plus a manual entry appended to `meta/_journal.json`; `drizzle-kit generate` is not used to produce them. At apply time the runtime migrator reads those `.sql` files directly from the drizzle folder — `packages/db/src/migrate.ts:18-20` calls `migrate(db, { migrationsFolder: ".../drizzle" })` — so the checked-in SQL is the source of truth, independent of the stale meta snapshots. The handwritten signature is visible in the files themselves: 22 of 36 migrations carry idempotent `IF NOT EXISTS` guards that `drizzle-kit generate` never emits (e.g. `packages/db/drizzle/0034_oauth_provider_metadata.sql:3`, `0007_thread_summary.sql:1`).

## Consequences
- **Buys auditability:** every schema change is a small, human-legible SQL diff that Rob reviews and gates directly — the point of a human-owned migration boundary. The self-review classes this as debt that is genuinely fine to carry, "*more* auditable than drizzle-kit" (`docs/reviews/REPO-SELF-REVIEW-2026-07-19.md:95`).
- **Buys robustness:** hand-written idempotent guards (`ADD COLUMN IF NOT EXISTS`, etc.) make re-runs safe in a merge-equals-deploy pipeline.
- **Costs manual discipline:** the author must write correct DDL and remember to append the `_journal.json` entry by hand; there is no generator cross-check, and `schema.ts` can silently diverge from the applied database.
- **Leaves an armed tripwire:** `package.json:16,19` and `drizzle.config.ts` still advertise `db:generate` and `db:check`. A new engineer — or Codex, which authors most PRs — who runs them gets a garbage diff computed against the 0023 snapshot; applied in prod it would fail or corrupt (`docs/reviews/REPO-SELF-REVIEW-2026-07-19.md:180`). The convention currently lives as tribal knowledge, not in `AGENTS.md`, `README.md`, or `docs/`.
- **Forecloses** drizzle-kit's snapshot-based tooling (studio diffing, `check` drift detection) until the snapshots are regenerated to match 0035.

## Status notes
The stale-snapshot / advertised-`db:generate` tripwire is a tracked follow-up (self-review issues #449 ops-floor / #467). The self-review's recommended resolution is to either regenerate the snapshots so drizzle-kit is trustworthy again, or remove/rename `db:generate`+`db:check` and document the handwritten-`.sql`+journal procedure in `AGENTS.md` (`docs/reviews/REPO-SELF-REVIEW-2026-07-19.md:181,255`).
