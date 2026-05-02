import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDb>;

interface CreateDbOptions {
  url: string;
  /** Max pool size. Default 10. */
  max?: number;
}

export function createDb({ url, max = 10 }: CreateDbOptions) {
  const sql = postgres(url, { max, prepare: false });
  return drizzle(sql, { schema });
}

let cached: { db: Database; url: string } | undefined;

/**
 * Process-wide singleton. Reads `DATABASE_URL` from env. Throws if unset.
 * Use this from API routes / scheduled tasks.
 */
export function getDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL must be set");
  }
  if (cached && cached.url === url) return cached.db;
  const db = createDb({ url });
  cached = { db, url };
  return db;
}

/**
 * Verifies the DB is reachable. Used by /api/health.
 * Returns the round-trip latency in ms, or throws.
 */
export async function pingDb(): Promise<number> {
  const db = getDb();
  const started = Date.now();
  // drizzle's `execute` accepts raw sql; we just need a round-trip.
  await db.execute("SELECT 1");
  return Date.now() - started;
}
