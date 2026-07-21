import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, rateLimitBuckets } from "@ai-workspace/db";
import { inArray, like } from "drizzle-orm";
import {
  checkRateLimit,
  resetRequestLimitBuckets,
  sweepExpiredRateLimitBuckets,
} from "@/lib/request-limits";

/**
 * The rate_limit_buckets sweep against real Postgres: expired-beyond-grace
 * rows are deleted, in-grace and in-window rows survive, and the sampled
 * hook inside `checkRateLimit`'s Postgres store actually fires. Suites skip
 * (not fail) when no DATABASE_URL is provided, matching the scoping suite.
 */

const DB_URL = process.env.DATABASE_URL;

const suite = describe.skipIf(!DB_URL);

suite("rate_limit_buckets sweep (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 2 });

  const keys = {
    longExpired: "sweep-it:long-expired",
    inGrace: "sweep-it:in-grace",
    inWindow: "sweep-it:in-window",
    probe: "sweep-it:probe",
  };

  async function cleanup() {
    await db
      .delete(rateLimitBuckets)
      .where(like(rateLimitBuckets.bucketKey, "sweep-it:%"));
  }

  async function seed() {
    const now = Date.now();
    await db.insert(rateLimitBuckets).values([
      {
        // Window closed two hours ago — beyond the one-hour grace.
        bucketKey: keys.longExpired,
        count: 5,
        resetAt: new Date(now - 2 * 60 * 60 * 1000),
        updatedAt: new Date(now - 2 * 60 * 60 * 1000),
      },
      {
        // Window closed 30 minutes ago — expired but inside the grace.
        bucketKey: keys.inGrace,
        count: 5,
        resetAt: new Date(now - 30 * 60 * 1000),
        updatedAt: new Date(now - 30 * 60 * 1000),
      },
      {
        // Still-open window.
        bucketKey: keys.inWindow,
        count: 1,
        resetAt: new Date(now + 10 * 60 * 1000),
        updatedAt: new Date(now),
      },
    ]);
  }

  beforeEach(async () => {
    resetRequestLimitBuckets();
    await cleanup();
    await seed();
  });
  afterAll(cleanup);

  async function remainingKeys(): Promise<string[]> {
    const rows = await db
      .select({ bucketKey: rateLimitBuckets.bucketKey })
      .from(rateLimitBuckets)
      .where(
        inArray(rateLimitBuckets.bucketKey, [
          keys.longExpired,
          keys.inGrace,
          keys.inWindow,
        ]),
      );
    return rows.map((row) => row.bucketKey).sort();
  }

  it("deletes only rows expired beyond the grace period", async () => {
    await sweepExpiredRateLimitBuckets(db);

    expect(await remainingKeys()).toEqual([keys.inGrace, keys.inWindow]);
  });

  it("fires through the sampled hook on a fresh process's first consume", async () => {
    // resetRequestLimitBuckets() zeroed the sampling counter, so this first
    // consume takes the 1-in-50 sweep branch.
    const result = await checkRateLimit(db, keys.probe, {
      maxRequestBytes: 1000,
      maxMessageChars: 100,
      windowMs: 60_000,
      maxRequests: 2,
    });

    expect(result.allowed).toBe(true);
    expect(await remainingKeys()).toEqual([keys.inGrace, keys.inWindow]);
  });
});
