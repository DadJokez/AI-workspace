import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  orgInstructions,
  userMemoryItems,
  users,
} from "@ai-workspace/db/schema";

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
 * `when` of 0050_web_egress_policy_reader (#870; 0049 from #872 is
 * 1788494400000). Both were applied in prod on 2026-09-06; 0051 must sort
 * after both — see the migration's header.
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

  it("orders 0051 (#438 org_instructions) after #870's 0050 and #872's 0049", () => {
    const entry = journal.entries.find(
      (candidate) => candidate.tag === "0051_org_instructions",
    );
    expect(entry).toBeDefined();
    expect(entry!.idx).toBe(51);
    expect(entry!.when).toBeGreaterThan(WHEN_0050_PR870);
    expect(journal.entries[50]!.tag).toBe("0050_web_egress_policy_reader");
    expect(journal.entries[49]!.tag).toBe("0049_app_version_data_bindings");
  });
});

/**
 * Rob's decision (2026-09-06): the org layer lives in its own table, never
 * as a `user_memory_items` scope — that table's `user_id` cascades on user
 * deletion, so offboarding the authoring admin would delete the org layer.
 * The SQL and the drizzle schema must both say SET NULL; the real-Postgres
 * proof is __integration__/org-instructions.integration.test.ts.
 */
describe("0051 org_instructions (#438 PR B)", () => {
  const statements = readFileSync(
    path.join(DRIZZLE_DIR, "0051_org_instructions.sql"),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("creates the table with authored_by ON DELETE SET NULL and leaves user_memory_items alone", () => {
    expect(statements).toContain('CREATE TABLE IF NOT EXISTS "org_instructions"');
    expect(statements).toMatch(
      /FOREIGN KEY \("authored_by"\) REFERENCES "public"\."users"\("id"\) ON DELETE set null/,
    );
    expect(statements).not.toContain("user_memory_items");
    expect(statements).not.toMatch(/\bscope\b/);
    expect(statements).not.toMatch(/\bCASCADE\b/i);
  });

  it("matches the drizzle schema: nullable authored_by → users.id, set null on delete; no scope on the Vault table", () => {
    const cfg = getTableConfig(orgInstructions);
    expect(cfg.name).toBe("org_instructions");
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0]!;
    expect(fk.onDelete).toBe("set null");
    const reference = fk.reference();
    expect(getTableConfig(reference.foreignTable).name).toBe(
      getTableConfig(users).name,
    );
    expect(reference.columns.map((column) => column.name)).toEqual(["authored_by"]);
    expect(cfg.columns.find((column) => column.name === "authored_by")?.notNull).toBe(false);
    expect(cfg.columns.map((column) => column.name)).toEqual([
      "id",
      "content",
      "status",
      "authored_by",
      "created_at",
      "updated_at",
    ]);
    expect(
      getTableConfig(userMemoryItems).columns.map((column) => column.name),
    ).not.toContain("scope");
  });
});
