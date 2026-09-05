import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Migrations are handwritten SQL + a `_journal.json` entry (#449; drizzle
 * meta is frozen). The migrator applies entries whose `when` exceeds the
 * last applied one, so a mis-ordered `when` makes a migration skip
 * silently in production. This guard keeps the journal self-consistent.
 */
const DRIZZLE_DIR = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../packages/db/drizzle",
);

/**
 * `when` of 0050_web_egress_policy_reader in open PR #870 (0049 in #872 is
 * 1788494400000). 0051 must sort after both — see the migration's header.
 */
const WHEN_0050_PR870 = 1788494460000;

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const journal = JSON.parse(
  readFileSync(path.join(DRIZZLE_DIR, "meta/_journal.json"), "utf8"),
) as { entries: JournalEntry[] };
const sqlTags = readdirSync(DRIZZLE_DIR)
  .filter((file) => file.endsWith(".sql"))
  .map((file) => file.replace(/\.sql$/, ""));

describe("drizzle migration journal (handwritten, #449)", () => {
  it("keeps idx and when strictly increasing", () => {
    for (let i = 1; i < journal.entries.length; i += 1) {
      const prev = journal.entries[i - 1]!;
      const next = journal.entries[i]!;
      expect(next.idx, `${next.tag} idx`).toBeGreaterThan(prev.idx);
      expect(next.when, `${next.tag} when`).toBeGreaterThan(prev.when);
      expect(next.breakpoints).toBe(true);
    }
  });

  it("has exactly one SQL file per journal entry", () => {
    expect([...journal.entries.map((entry) => entry.tag)].sort()).toEqual(
      [...sqlTags].sort(),
    );
  });

  it("orders 0051 (#438 org scope) after #870's 0050 and #872's 0049", () => {
    const entry = journal.entries.find(
      (candidate) => candidate.tag === "0051_user_memory_items_org_scope",
    );
    expect(entry).toBeDefined();
    expect(entry!.idx).toBe(51);
    expect(entry!.when).toBeGreaterThan(WHEN_0050_PR870);
  });
});
