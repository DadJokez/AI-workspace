import { describe, expect, it } from "vitest";
import type { Database } from "@ai-workspace/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  processPendingMemoryCaptures,
  sweepSettledMemoryCaptures,
} from "@/lib/memory-capture";

/**
 * Chainable fake for the Drizzle query builder (same pattern as
 * notifications.test.ts): builder methods return the chain; terminal selects
 * resolve from `selectResults` in call order. Captures delete conditions so
 * the retention predicate itself can be asserted (#462).
 */
function fakeDb(selectResults: Array<Array<Record<string, unknown>>> = []) {
  const captured: { deleteWheres: SQL[] } = { deleteWheres: [] };

  const nextSelect = () => Promise.resolve(selectResults.shift() ?? []);

  function selectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => {
      const pending = nextSelect();
      return Object.assign(pending, {
        orderBy: () => pending,
        limit: () => pending,
      });
    };
    return chain;
  }

  const db = {
    select: () => selectChain(),
    delete: () => ({
      where: (condition: SQL) => {
        captured.deleteWheres.push(condition);
        return Promise.resolve();
      },
    }),
  } as unknown as Database;

  return { db, captured };
}

function renderCondition(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

describe("sweepSettledMemoryCaptures", () => {
  it("deletes only settled rows past the 7-day retention bound", async () => {
    const { db, captured } = fakeDb();
    const now = new Date("2026-07-19T12:00:00Z");

    await sweepSettledMemoryCaptures(db, now);

    expect(captured.deleteWheres).toHaveLength(1);
    const query = renderCondition(captured.deleteWheres[0]!);
    expect(query.sql).toContain('"status" in (');
    expect(query.sql).toContain('"processed_at" <');
    // Exact params: the terminal statuses only — pending/processing rows are
    // never swept — and the cutoff is now minus the retention window.
    expect(query.params).toEqual([
      "processed",
      "skipped",
      "failed",
      "2026-07-12T12:00:00.000Z",
    ]);
  });
});

describe("processPendingMemoryCaptures", () => {
  it("sweeps settled rows on every pass, even an idle one", async () => {
    const { db, captured } = fakeDb();

    const result = await processPendingMemoryCaptures({ db });

    expect(result).toEqual({ status: "idle", captures: 0, suggestions: 0 });
    // The queue was insert-per-turn, delete-never (#462); retention now rides
    // on the worker loop, so an idle poll must still issue the sweep.
    expect(captured.deleteWheres).toHaveLength(1);
  });
});
