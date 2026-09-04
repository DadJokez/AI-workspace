import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #846: coarse per-user scoping guard for user-facing surfaces.
 *
 * The #827 fix ("scope shared skill history") closed a two-month cross-user
 * read on the skill detail page: `.from(runs).where(eq(runs.skillId, …))`
 * carried no `runs.userId` predicate, so every viewer of a starter skill saw
 * every other user's runs. Nothing structural would have caught it — the
 * unit-lane db mocks discard WHERE clauses, and the integration lane had no
 * case for the page.
 *
 * This guard checks the SQL surface, not the caller chain: every
 * `.from(<table with a user_id column>)` in a `page.tsx` or `route.ts` under
 * `app/**` (minus the admin, webhook, auth and e2e trees) must carry a
 * `.userId` or `userScope(` predicate inside the same statement. Statements
 * scoped by another access model (app roles, in-thread proof) are allowlisted
 * per (file, table) — and a stale allowlist entry fails the test so the list
 * cannot rot. Do not "fix" allowlisted statements to satisfy the guard.
 */

const GUARDED_TABLES = [
  "runs",
  "chatThreads",
  "workspaceArtifacts",
  "schedules",
  "eventTriggers",
  "notifications",
  "toolApprovalRequests",
  "skillToolStandingApprovals",
  "userMemoryItems",
  "studioBrowserSessions",
  "studioSandboxEndpoints",
  "recommendations",
];

const SKIP_PREFIXES = [
  "app/admin/",
  "app/api/admin/",
  "app/api/webhooks/",
  "app/api/auth/",
  "app/e2e/",
];

const SCOPE_PREDICATE = /\.userId\b|userScope\(/;

interface AllowlistEntry {
  file: string;
  table: string;
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    file: "app/api/threads/route.ts",
    table: "chatThreads",
    reason:
      "predicate is the `scope` variable built from userScope() at :31-34 and applied at :54",
  },
  {
    file: "app/api/chat/route.ts",
    table: "workspaceArtifacts",
    reason:
      ":437-439 and :606-608 key on chatMessageId, which is proven in-thread at :372-379",
  },
  {
    file: "app/api/output-proposals/iterate/route.ts",
    table: "workspaceArtifacts",
    reason:
      ":479-485 resolves via app role (:458-464) and the artifact.threadId !== threadId check at :483",
  },
  {
    file: "app/api/apps/[id]/versions/[versionId]/route.ts",
    table: "workspaceArtifacts",
    reason:
      ":68-70 is reached only after canAppRoleEdit (:50-53) and loadAppVersion (:54)",
  },
];

interface Finding {
  file: string;
  table: string;
  line: number;
}

/**
 * Every guarded `.from(<table>)` in `source` whose statement window — from
 * the match to the earliest of the next `;` or the next `.from(` — carries
 * no scope predicate. The second bound keeps a `Promise.all([...])` from
 * masking an earlier unscoped query behind a later scoped one.
 */
function findUnscopedQueries(file: string, source: string): Finding[] {
  const fromPattern = new RegExp(
    `\\.from\\(\\s*(${GUARDED_TABLES.join("|")})\\s*\\)`,
    "g",
  );
  const findings: Finding[] = [];
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(source)) !== null) {
    const start = match.index;
    const after = start + match[0].length;
    const bounds = [
      source.indexOf(";", after),
      source.indexOf(".from(", after),
    ].filter((index) => index !== -1);
    const end = bounds.length > 0 ? Math.min(...bounds) : source.length;
    if (SCOPE_PREDICATE.test(source.slice(start, end))) continue;
    findings.push({
      file,
      table: match[1]!,
      line: source.slice(0, start).split("\n").length,
    });
  }
  return findings;
}

function collectSurfaceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSurfaceFiles(path);
    return entry.name === "page.tsx" || entry.name === "route.ts"
      ? [path]
      : [];
  });
}

describe("per-user scoping guard (#846)", () => {
  it("scopes every user-facing query on a user_id table, or allowlists it", () => {
    const webRoot = process.cwd();
    const findings = collectSurfaceFiles(join(webRoot, "app"))
      .map((path) => relative(webRoot, path).split(sep).join("/"))
      .filter((file) => !SKIP_PREFIXES.some((prefix) => file.startsWith(prefix)))
      .flatMap((file) =>
        findUnscopedQueries(file, readFileSync(join(webRoot, file), "utf8")),
      );

    const covers = (entry: AllowlistEntry, finding: Finding) =>
      entry.file === finding.file && entry.table === finding.table;

    const unscoped = findings.filter(
      (finding) => !ALLOWLIST.some((entry) => covers(entry, finding)),
    );
    expect(unscoped).toEqual([]);

    // A stale entry means the statement it excused is now scoped (or gone);
    // prune it so the allowlist keeps documenting only live exceptions.
    const stale = ALLOWLIST.filter(
      (entry) => !findings.some((finding) => covers(entry, finding)),
    );
    expect(stale).toEqual([]);
  });

  it("reports a query that filters by skill but not by user", () => {
    const snippet = [
      "const history = await db",
      "  .select()",
      "  .from(runs)",
      "  .where(eq(runs.skillId, skill.id))",
      "  .limit(20);",
    ].join("\n");
    expect(findUnscopedQueries("app/skills/[id]/page.tsx", snippet)).toEqual([
      { file: "app/skills/[id]/page.tsx", table: "runs", line: 3 },
    ]);
  });
});
