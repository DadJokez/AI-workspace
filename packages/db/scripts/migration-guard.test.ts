import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { census, checkJournal, scanMigration } from "./migration-guard.mjs";

const GUARD = fileURLToPath(new URL("./migration-guard.mjs", import.meta.url));
const REAL_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

interface Entry {
  tag: string;
  when: number;
  idx?: number;
}

/** Writes a drizzle folder: journal entries (idx defaults to position) plus the given files. */
function writeFolder(folder: string, entries: Entry[], files: Record<string, string>) {
  mkdirSync(path.join(folder, "meta"), { recursive: true });
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify(
      {
        version: "7",
        dialect: "postgresql",
        entries: entries.map((entry, position) => ({
          idx: entry.idx ?? position,
          version: "7",
          when: entry.when,
          tag: entry.tag,
          breakpoints: true,
        })),
      },
      null,
      2,
    ),
  );
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(folder, name), sql);
}

function tempFolder(entries: Entry[], files: Record<string, string>): string {
  const folder = mkdtempSync(path.join(tmpdir(), "migration-guard-"));
  writeFolder(folder, entries, files);
  return folder;
}

describe("migration guard: additive-only scan", () => {
  it("passes an additive migration, including the look-alikes", () => {
    const sql = [
      "-- comment mentioning DROP COLUMN and a RENAME must not count",
      'CREATE TABLE IF NOT EXISTS "widgets" (',
      '\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
      '\t"user_id" uuid NOT NULL,',
      '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL',
      ");--> statement-breakpoint",
      "DO $$ BEGIN",
      ' ALTER TABLE "widgets" ADD CONSTRAINT "widgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;',
      "EXCEPTION",
      " WHEN duplicate_object THEN null;",
      "END $$;--> statement-breakpoint",
      'ALTER TABLE "widgets" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint',
      'CREATE INDEX IF NOT EXISTS "widgets_user_idx" ON "widgets" ("user_id");--> statement-breakpoint',
      "INSERT INTO \"tools_catalog\" (\"id\", \"description\") VALUES ('x', 'DELETE FROM the UI; RENAME later')",
      'ON CONFLICT ("id") DO UPDATE SET "description" = EXCLUDED."description";--> statement-breakpoint',
      'ALTER TABLE "widgets" ALTER COLUMN "color" SET DEFAULT \'blue\';',
    ].join("\n");
    expect(scanMigration("0001_widgets.sql", sql)).toEqual({ denied: [], stale: [] });
  });

  it.each([
    ['DROP TABLE "widgets";', "DROP TABLE"],
    ['ALTER TABLE "widgets" DROP COLUMN "color";', "DROP COLUMN"],
    ['ALTER TABLE "widgets" DROP COLUMN IF EXISTS "color";', "DROP COLUMN"],
    ['ALTER TABLE "widgets" DROP "color";', "DROP COLUMN"],
    ['DROP INDEX IF EXISTS "widgets_user_idx";', "DROP INDEX"],
    ['ALTER TABLE "widgets" RENAME TO "gadgets";', "RENAME"],
    ['ALTER TABLE "widgets" RENAME COLUMN "color" TO "colour";', "RENAME"],
    ['ALTER TYPE "public"."run_status" ADD VALUE IF NOT EXISTS \'paused\';', "ALTER TYPE"],
    ['ALTER TABLE "widgets" ALTER COLUMN "color" TYPE varchar(32);', "ALTER COLUMN … TYPE"],
    ['ALTER TABLE "widgets" ALTER COLUMN "color" SET DATA TYPE text;', "ALTER COLUMN … TYPE"],
    ['ALTER TABLE "widgets" ALTER COLUMN "color" SET NOT NULL;', "SET NOT NULL"],
    ['TRUNCATE "widgets";', "TRUNCATE"],
    ['DELETE FROM "widgets" WHERE "color" IS NULL;', "DELETE FROM"],
    ['UPDATE "widgets" SET "color" = \'blue\' WHERE "color" IS NULL;', "UPDATE"],
    [
      'WITH stale AS (SELECT "id" FROM "widgets")\nUPDATE "widgets" SET "color" = NULL WHERE "id" IN (SELECT "id" FROM stale);',
      "UPDATE",
    ],
  ])("denies %s", (statement, rule) => {
    const sql = `CREATE TABLE IF NOT EXISTS "other" ("id" uuid);--> statement-breakpoint\n${statement}`;
    expect(scanMigration("0001_x.sql", sql)).toEqual({
      denied: [{ file: "0001_x.sql", line: 2, rules: [rule], allowed: null }],
      stale: [],
    });
  });

  it("looks inside DO $$ … $$ bodies and does not split on their semicolons", () => {
    const sql = [
      "DO $$ BEGIN",
      '  ALTER TABLE "runs" RENAME CONSTRAINT "recipe_runs_pkey" TO "runs_pkey";',
      "EXCEPTION WHEN undefined_object THEN null;",
      "END $$;",
    ].join("\n");
    expect(scanMigration("0021_x.sql", sql).denied).toEqual([
      { file: "0021_x.sql", line: 1, rules: ["RENAME"], allowed: null },
    ]);
  });

  it("reports every rule a statement trips, at the line its first token is on", () => {
    const sql = '\n\n  ALTER TYPE "recipe_run_status"\n    RENAME TO "run_status";';
    expect(scanMigration("0021_x.sql", sql).denied).toEqual([
      { file: "0021_x.sql", line: 3, rules: ["RENAME", "ALTER TYPE"], allowed: null },
    ]);
  });

  it("lets a marker on the line above (or inside, before the semicolon) excuse one statement", () => {
    const sql = [
      "-- migration-guard-allow: is_admin was folded into role above; nothing reads it after #123",
      'ALTER TABLE "users" DROP COLUMN IF EXISTS "is_admin";--> statement-breakpoint',
      'ALTER TABLE "users" -- migration-guard-allow: legacy column, two-phase contract step',
      '  DROP COLUMN IF EXISTS "legacy";--> statement-breakpoint',
      'ALTER TABLE "users" DROP COLUMN IF EXISTS "unexcused";',
    ].join("\n");
    expect(scanMigration("0050_x.sql", sql)).toEqual({
      denied: [
        {
          file: "0050_x.sql",
          line: 2,
          rules: ["DROP COLUMN"],
          allowed: "is_admin was folded into role above; nothing reads it after #123",
        },
        {
          file: "0050_x.sql",
          line: 3,
          rules: ["DROP COLUMN"],
          allowed: "legacy column, two-phase contract step",
        },
        { file: "0050_x.sql", line: 5, rules: ["DROP COLUMN"], allowed: null },
      ],
      stale: [],
    });
  });

  it("fails a stale marker: nothing denied follows it, or it has no reason", () => {
    const sql = [
      "-- migration-guard-allow: this column was dropped in an earlier revision of the PR",
      'ALTER TABLE "users" ADD COLUMN "nickname" text;--> statement-breakpoint',
      "-- migration-guard-allow:",
      'ALTER TABLE "users" DROP COLUMN "nickname";--> statement-breakpoint',
      "-- migration-guard-allow: trailing marker with no statement after it",
    ].join("\n");
    expect(scanMigration("0050_x.sql", sql)).toEqual({
      denied: [{ file: "0050_x.sql", line: 4, rules: ["DROP COLUMN"], allowed: null }],
      stale: [
        { file: "0050_x.sql", line: 1, why: "no denied statement follows it" },
        { file: "0050_x.sql", line: 3, why: "it has no reason after the colon" },
        { file: "0050_x.sql", line: 5, why: "no denied statement follows it" },
      ],
    });
  });
});

describe("migration guard: journal consistency", () => {
  const base = { "0000_base.sql": 'CREATE TABLE "a" ("id" uuid);' };

  it("passes a consistent folder", () => {
    const folder = tempFolder(
      [
        { tag: "0000_base", when: 100 },
        { tag: "0001_next", when: 200 },
      ],
      { ...base, "0001_next.sql": 'CREATE TABLE "b" ("id" uuid);' },
    );
    expect(checkJournal(folder)).toEqual([]);
  });

  it("fails a when that does not exceed its predecessor's — the migrator would skip it", () => {
    const folder = tempFolder(
      [
        { tag: "0000_base", when: 200 },
        { tag: "0001_next", when: 150 },
      ],
      { ...base, "0001_next.sql": 'CREATE TABLE "b" ("id" uuid);' },
    );
    const problems = checkJournal(folder);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(
      /^meta\/_journal\.json:\d+: when 150 is not greater than the previous entry's 200 — .*silently never run in prod$/,
    );
    expect(problems[1]).toMatch(/highest-idx entry "0001_next" does not have the highest when/);
  });

  it("fails a file with no journal entry and an entry with no file", () => {
    const folder = tempFolder([{ tag: "0000_base", when: 100 }, { tag: "0001_ghost", when: 200 }], {
      ...base,
      "0002_orphan.sql": 'CREATE TABLE "c" ("id" uuid);',
    });
    expect(checkJournal(folder)).toEqual([
      '0002_orphan.sql: no meta/_journal.json entry with tag "0002_orphan" — the migrator only runs files the journal lists',
      expect.stringMatching(/^meta\/_journal\.json:\d+: entry "0001_ghost" has no 0001_ghost\.sql$/),
    ]);
  });

  it("fails duplicate entries for one tag", () => {
    const folder = tempFolder(
      [
        { tag: "0000_base", when: 100 },
        { tag: "0000_base", when: 200, idx: 1 },
      ],
      base,
    );
    expect(checkJournal(folder)).toEqual([
      expect.stringMatching(/^meta\/_journal\.json:\d+: 2 entries share tag "0000_base"$/),
      expect.stringMatching(/tag prefix 0000 does not match idx 1/),
    ]);
  });

  it("fails the parallel-lane shapes: an idx gap, and a file number that is not its idx", () => {
    const folder = tempFolder(
      [
        { tag: "0000_base", when: 100 },
        { tag: "0050_lane_b", when: 200, idx: 49 },
      ],
      { ...base, "0050_lane_b.sql": 'CREATE TABLE "b" ("id" uuid);' },
    );
    expect(checkJournal(folder)).toEqual([
      expect.stringMatching(/idx 49 at position 1 — idx must run contiguously from 0/),
      expect.stringMatching(/tag prefix 0050 does not match idx 49/),
    ]);
  });

  it("holds for the real folder", () => {
    expect(checkJournal(REAL_FOLDER)).toEqual([]);
  });
});

describe("migration guard: historical census", () => {
  it("pins every deny-list statement in the shipped migrations", () => {
    // Every line here was reviewed by a human when it shipped. A rule change
    // that adds or removes a line is a deliberate change to what the guard
    // means — update this list in the same PR and say why.
    const lines = census(REAL_FOLDER).map(
      (hit: { file: string; line: number; rules: string[]; allowed: string | null }) =>
        `${hit.file}:${hit.line} ${hit.rules.join(", ")}${hit.allowed ? " [allowed]" : ""}`,
    );
    expect(lines).toEqual([
      "0005_users_role.sql:8 UPDATE",
      "0005_users_role.sql:9 DROP COLUMN",
      "0014_mcp_servers.sql:59 UPDATE",
      "0021_skills_spine.sql:5 RENAME",
      "0021_skills_spine.sql:6 RENAME",
      "0021_skills_spine.sql:7 RENAME",
      "0021_skills_spine.sql:8 RENAME",
      "0021_skills_spine.sql:9 RENAME",
      "0021_skills_spine.sql:10 RENAME",
      "0021_skills_spine.sql:11 RENAME",
      "0021_skills_spine.sql:12 RENAME, ALTER TYPE",
      "0021_skills_spine.sql:13 RENAME",
      "0021_skills_spine.sql:14 RENAME",
      "0021_skills_spine.sql:15 RENAME",
      "0021_skills_spine.sql:16 RENAME",
      "0021_skills_spine.sql:17 RENAME",
      "0021_skills_spine.sql:18 RENAME",
      "0021_skills_spine.sql:19 RENAME",
      "0021_skills_spine.sql:20 RENAME",
      "0021_skills_spine.sql:21 RENAME",
      "0021_skills_spine.sql:22 RENAME",
      "0021_skills_spine.sql:23 RENAME",
      "0021_skills_spine.sql:24 RENAME",
      "0021_skills_spine.sql:27 RENAME",
      "0021_skills_spine.sql:30 RENAME",
      "0021_skills_spine.sql:100 UPDATE",
      "0025_artifact_versions_recommendations.sql:9 UPDATE",
      "0025_artifact_versions_recommendations.sql:13 SET NOT NULL",
      "0027_app_lifecycle_versions.sql:71 UPDATE",
      "0037_run_events_sequence_unique.sql:9 UPDATE",
      "0045_tool_policy_persistence.sql:12 UPDATE",
      "0045_tool_policy_persistence.sql:20 SET NOT NULL",
      "0046_tool_approval_lifecycle.sql:1 ALTER TYPE",
      "0047_standing_tool_approvals.sql:2 UPDATE",
      "0047_standing_tool_approvals.sql:5 SET NOT NULL",
      "0048_connector_lifecycle_governance.sql:5 UPDATE",
      "0048_connector_lifecycle_governance.sql:7 SET NOT NULL",
      "0048_connector_lifecycle_governance.sql:26 UPDATE",
    ]);
  });
});

describe("migration guard: CLI against a git base", () => {
  /** A throwaway repo whose main has one additive migration. */
  function repo() {
    const dir = mkdtempSync(path.join(tmpdir(), "migration-guard-repo-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "guard@example.test");
    git("config", "user.name", "migration guard test");
    const folder = path.join(dir, "packages", "db", "drizzle");
    const journal = (entries: Entry[], files: Record<string, string>) =>
      writeFolder(folder, [{ tag: "0000_base", when: 100 }, ...entries], {
        "0000_base.sql": 'CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "color" text);',
        ...files,
      });
    journal([], {});
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    return { git, folder, journal };
  }

  function run(folder: string, base = "main") {
    const result = spawnSync(process.execPath, [GUARD, "--base", base, "--folder", folder], {
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("passes when no migration changed", () => {
    const { folder } = repo();
    expect(run(folder)).toEqual({
      status: 0,
      stdout: "migration guard: ok (journal consistent; no migrations changed vs main)\n",
      stderr: "",
    });
  });

  it("fails a committed DROP COLUMN on a branch with file:line, and passes it once marked", () => {
    const { git, folder, journal } = repo();
    git("checkout", "-q", "-b", "feature");
    journal([{ tag: "0001_drop_color", when: 200 }], {
      "0001_drop_color.sql": 'ALTER TABLE "widgets" DROP COLUMN "color";',
    });
    git("add", "-A");
    git("commit", "-q", "-m", "drop color");

    const failed = run(folder);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      "migration guard: 1 finding(s) (1 changed migration(s): 0001_drop_color.sql vs main)",
    );
    expect(failed.stderr).toContain(
      'packages/db/drizzle/0001_drop_color.sql:1: DROP COLUMN is not additive — excuse it with "-- migration-guard-allow: <reason>" on the line above',
    );

    // Uncommitted edits count: the guard compares the working tree.
    journal([{ tag: "0001_drop_color", when: 200 }], {
      "0001_drop_color.sql":
        '-- migration-guard-allow: color moved to widget_styles in 0001; reviewed contract step\nALTER TABLE "widgets" DROP COLUMN "color";',
    });
    expect(run(folder)).toEqual({
      status: 0,
      stdout:
        "migration guard: ok (journal consistent; 1 changed migration(s): 0001_drop_color.sql vs main)\n",
      stderr: "",
    });
  });

  it("scans an untracked migration and fails its stale marker", () => {
    const { folder, journal } = repo();
    journal([{ tag: "0001_nickname", when: 200 }], {
      "0001_nickname.sql":
        '-- migration-guard-allow: left over from a draft that dropped a column\nALTER TABLE "widgets" ADD COLUMN "nickname" text;',
    });
    const result = run(folder);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/db/drizzle/0001_nickname.sql:1: stale migration-guard-allow marker — no denied statement follows it",
    );
  });

  it("fails a journal regression even when the SQL is untouched", () => {
    const { git, folder, journal } = repo();
    git("checkout", "-q", "-b", "feature");
    journal([{ tag: "0001_next", when: 50 }], {
      "0001_next.sql": 'CREATE TABLE "gadgets" ("id" uuid PRIMARY KEY);',
    });
    const result = run(folder);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /packages\/db\/drizzle\/meta\/_journal\.json:\d+: when 50 is not greater than the previous entry's 100/,
    );
  });

  it("names a missing base ref instead of guessing", () => {
    const { folder } = repo();
    const result = run(folder, "origin/nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('migration guard: base ref "origin/nope" not found');
  });
});
