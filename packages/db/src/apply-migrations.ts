/**
 * The migration step with fail-fast timeouts (#898). `migrate.ts` is the CLI
 * entry; this module is what the unit test exercises.
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "./client";

/**
 * How long a DDL statement may wait for its lock. A migration queued behind a
 * long-running transaction otherwise holds its lock request open — stalling
 * every later query on that table — until CodeBuild's 30-minute cap kills the
 * build. 10s turns "prod crawls for half an hour" into "the deploy fails fast".
 */
export const LOCK_TIMEOUT = "10s";
/**
 * Upper bound for any single migration statement. A backfill or index build
 * that needs longer belongs in a batched, two-phase migration, not on the
 * deploy path.
 */
export const STATEMENT_TIMEOUT = "5min";

/** Postgres SQLSTATEs: 55P03 lock_not_available, 57014 query_canceled. */
const TIMEOUT_BY_SQLSTATE: Record<string, "lock_timeout" | "statement_timeout"> = {
  "55P03": "lock_timeout",
  "57014": "statement_timeout",
};

export class MigrationTimeoutError extends Error {}

/**
 * The env overrides exist for tests; nothing else should set them. SET cannot
 * take a bind parameter, so the value is checked against a bare Postgres
 * duration literal before it is interpolated.
 */
function timeoutSetting(envName: string, fallback: string): string {
  const value = process.env[envName] ?? fallback;
  if (!/^\d+(ms|s|min|h)?$/.test(value)) {
    throw new Error(
      `${envName} must be a Postgres duration like 10s, 500ms or 5min, got "${value}"`,
    );
  }
  return value;
}

export async function applyMigrations(db: Database, migrationsFolder: string): Promise<void> {
  const lockTimeout = timeoutSetting("MIGRATE_LOCK_TIMEOUT", LOCK_TIMEOUT);
  const statementTimeout = timeoutSetting("MIGRATE_STATEMENT_TIMEOUT", STATEMENT_TIMEOUT);
  // Session-level, on the pool's only connection (createDb max: 1), so the
  // single transaction drizzle opens for every pending migration inherits both.
  await db.execute(`SET lock_timeout = '${lockTimeout}'`);
  await db.execute(`SET statement_timeout = '${statementTimeout}'`);
  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    // drizzle wraps the driver error in a DrizzleQueryError: the SQL text is on
    // the wrapper, the SQLSTATE on its `cause` (the postgres-js PostgresError).
    const failure = err as {
      code?: string;
      query?: string;
      cause?: { code?: string; query?: string };
    };
    const code = failure.code ?? failure.cause?.code;
    const query = failure.query ?? failure.cause?.query;
    const timeout = code === undefined ? undefined : TIMEOUT_BY_SQLSTATE[code];
    if (timeout === undefined) throw err;
    const limit = timeout === "lock_timeout" ? lockTimeout : statementTimeout;
    throw new MigrationTimeoutError(
      `${timeout} (${limit}) fired while applying migration ${migrationTagFor(migrationsFolder, query)}; the migration transaction rolled back, so nothing was applied`,
      { cause: err },
    );
  }
}

/**
 * Drizzle does not say which migration a failed statement belongs to, but
 * postgres-js attaches the failing query text to the error, and drizzle runs
 * each file's `--> statement-breakpoint` chunks verbatim — so the chunk that
 * equals the query names the tag.
 */
function migrationTagFor(folder: string, query: string | undefined): string {
  const journalPath = path.join(folder, "meta", "_journal.json");
  if (!query || !existsSync(journalPath)) return "(unknown)";
  const { entries } = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const wanted = query.trim();
  for (const { tag } of entries) {
    const file = path.join(folder, `${tag}.sql`);
    if (!existsSync(file)) continue;
    const chunks = readFileSync(file, "utf8").split("--> statement-breakpoint");
    if (chunks.some((chunk) => chunk.trim() === wanted)) return tag;
  }
  return "(unknown — the failing statement is not in any journaled file)";
}
