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
 * `.userId` or `userScope(` predicate inside the same statement. A statement
 * scoped by another access model (app roles, in-thread proof) is excused by
 * an inline `// scoping-guard-allow: <reason>` marker on its `.from(...)`
 * line or the line directly above. One marker excuses exactly one statement,
 * so a new unmarked query on the same table in the same file still fails; a
 * stale marker (on a statement that is now scoped, or no longer adjacent to
 * a guarded `.from(`) fails too, so exceptions cannot rot. Do not "fix"
 * marked statements to satisfy the guard.
 *
 * Coverage is inline-only: the walker sees `.from(...)` written directly in
 * `app/**` `page.tsx`/`route.ts`; a query reached through a `lib/` helper is
 * not walked.
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
const ALLOW_MARKER = /\/\/\s*scoping-guard-allow:.*/;

interface Finding {
  file: string;
  table: string;
  line: number;
}

interface Marker {
  file: string;
  line: number;
}

interface Scan {
  /** Guarded statements with neither a scope predicate nor a marker. */
  unscoped: Finding[];
  /** Markers that excuse nothing: the statement is scoped, or no guarded `.from(` is adjacent. */
  stale: Marker[];
}

/**
 * Every guarded `.from(<table>)` in `source` is checked over its statement
 * window — from the match to the earliest of the next `;` or the next
 * `.from(` — for a scope predicate. The second bound keeps a
 * `Promise.all([...])` from masking an earlier unscoped query behind a later
 * scoped one. A marker belongs to the statement whose `.from(` sits on the
 * marker's own line or the line below it.
 */
function scanSource(file: string, source: string): Scan {
  const fromPattern = new RegExp(
    `\\.from\\(\\s*(${GUARDED_TABLES.join("|")})\\s*\\)`,
    "g",
  );
  const markerLines = source
    .split("\n")
    .flatMap((text, index) => (ALLOW_MARKER.test(text) ? [index + 1] : []));
  // marker line -> whether the statement it sits on actually needed excusing
  const excuses = new Map<number, boolean>();
  const unscoped: Finding[] = [];
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(source)) !== null) {
    const start = match.index;
    const after = start + match[0].length;
    const bounds = [
      source.indexOf(";", after),
      source.indexOf(".from(", after),
    ].filter((index) => index !== -1);
    const end = bounds.length > 0 ? Math.min(...bounds) : source.length;
    // A trailing marker's reason lives inside the window; it must not read as a predicate.
    const statement = source
      .slice(start, end)
      .replace(new RegExp(ALLOW_MARKER.source, "g"), "");
    const scoped = SCOPE_PREDICATE.test(statement);
    const line = source.slice(0, start).split("\n").length;
    const marker = [line, line - 1].find((candidate) =>
      markerLines.includes(candidate),
    );
    if (marker !== undefined) excuses.set(marker, !scoped);
    else if (!scoped) unscoped.push({ file, table: match[1]!, line });
  }
  const stale = markerLines
    .filter((line) => !excuses.get(line))
    .map((line) => ({ file, line }));
  return { unscoped, stale };
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
  it("scopes every user-facing query on a user_id table, or marks it inline", () => {
    const webRoot = process.cwd();
    const scans = collectSurfaceFiles(join(webRoot, "app"))
      .map((path) => relative(webRoot, path).split(sep).join("/"))
      .filter((file) => !SKIP_PREFIXES.some((prefix) => file.startsWith(prefix)))
      .map((file) => scanSource(file, readFileSync(join(webRoot, file), "utf8")));

    expect(scans.flatMap((scan) => scan.unscoped)).toEqual([]);

    // A stale marker means the statement it excused is now scoped (or gone);
    // remove it so markers keep documenting only live exceptions.
    expect(scans.flatMap((scan) => scan.stale)).toEqual([]);
  });

  it("reports a query that filters by skill but not by user", () => {
    const snippet = [
      "const history = await db",
      "  .select()",
      "  .from(runs)",
      "  .where(eq(runs.skillId, skill.id))",
      "  .limit(20);",
    ].join("\n");
    expect(scanSource("app/skills/[id]/page.tsx", snippet)).toEqual({
      unscoped: [{ file: "app/skills/[id]/page.tsx", table: "runs", line: 3 }],
      stale: [],
    });
  });

  it("passes a marked statement, with the marker above or on the .from() line", () => {
    const snippet = [
      "const attached = await db",
      "  .select({ id: workspaceArtifacts.id })",
      "  // scoping-guard-allow: keys on chatMessageId, proven in-thread above",
      "  .from(workspaceArtifacts)",
      "  .where(eq(workspaceArtifacts.chatMessageId, targetId));",
      "const artifact = await db",
      "  .select()",
      "  .from(workspaceArtifacts) // scoping-guard-allow: app role gates this read, no .userId by design",
      "  .where(eq(workspaceArtifacts.id, version.artifactId));",
    ].join("\n");
    expect(scanSource("app/api/chat/route.ts", snippet)).toEqual({
      unscoped: [],
      stale: [],
    });
  });

  it("fails an unmarked second query on the same table in the same file", () => {
    const snippet = [
      "const attached = await db",
      "  .select({ id: workspaceArtifacts.id })",
      "  // scoping-guard-allow: keys on chatMessageId, proven in-thread above",
      "  .from(workspaceArtifacts)",
      "  .where(eq(workspaceArtifacts.chatMessageId, targetId));",
      "const recent = await db",
      "  .select({ id: workspaceArtifacts.id })",
      "  .from(workspaceArtifacts)",
      '  .where(eq(workspaceArtifacts.kind, "app"));',
    ].join("\n");
    expect(scanSource("app/api/chat/route.ts", snippet)).toEqual({
      unscoped: [
        { file: "app/api/chat/route.ts", table: "workspaceArtifacts", line: 8 },
      ],
      stale: [],
    });
  });

  it("fails a stale marker: on a scoped statement, or with no adjacent .from()", () => {
    const snippet = [
      "const history = await db",
      "  .select()",
      "  // scoping-guard-allow: reviewed before the userId predicate landed",
      "  .from(runs)",
      "  .where(and(eq(runs.skillId, skill.id), eq(runs.userId, sessionUser.id)));",
      "// scoping-guard-allow: the statement this excused was deleted",
      "const count = history.length;",
    ].join("\n");
    expect(scanSource("app/skills/[id]/page.tsx", snippet)).toEqual({
      unscoped: [],
      stale: [
        { file: "app/skills/[id]/page.tsx", line: 3 },
        { file: "app/skills/[id]/page.tsx", line: 6 },
      ],
    });
  });
});
