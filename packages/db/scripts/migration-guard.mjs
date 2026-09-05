#!/usr/bin/env node
/**
 * Migration guard (#898) for packages/db/drizzle. Node stdlib only; runs in
 * milliseconds; exits non-zero with file:line findings.
 *
 * Two properties become mechanical:
 *
 * 1. Journal consistency — checked over the WHOLE folder on every run. The
 *    migrator (drizzle-orm pg-core/dialect.js `migrate`) applies a journal
 *    entry only when its `when` is greater than the `created_at` of the last
 *    applied row, so an entry whose `when` is lower than its predecessor's
 *    silently never runs in prod while passing CI from an empty database.
 *    Every NNNN_*.sql needs exactly one journal entry whose tag is the file
 *    stem; idx must run contiguously from 0 and match the NNNN prefix (the
 *    0049-vs-0050 parallel-lane collision of 2026-09-04); `when` must strictly
 *    increase with idx.
 *
 * 2. Additive-only — checked over the migrations ADDED OR CHANGED since
 *    `--base` (default origin/main). A statement matching the deny list
 *    (DROP TABLE / DROP COLUMN / DROP INDEX / RENAME / ALTER TYPE /
 *    ALTER COLUMN … TYPE / SET NOT NULL / TRUNCATE / DELETE FROM / UPDATE)
 *    fails unless a `-- migration-guard-allow: <reason>` comment sits
 *    directly above it (or inside it, before its `;`). One marker excuses
 *    exactly one statement; a marker that excuses nothing is stale and fails,
 *    so exceptions cannot rot — the same shape as `// scoping-guard-allow:`
 *    (#858). A marked statement is the reviewer's cue for `needs-rob` (#891):
 *    a human decides; the guard never auto-fails it.
 *
 * `--census` lists every deny-list match in every file, marked or not, and
 * never fails; the fixture test pins the historical census so a rule change
 * that would have flagged history differently is visible.
 *
 * NO SQL PARSER. Statements are split on `;` outside single-quoted strings,
 * double-quoted identifiers, `--` and slash-star comments, and $tag$ dollar
 * quotes. Before the deny-list regexes run, string, identifier and comment
 * contents are blanked (delimiters and newlines kept, so offsets and line
 * numbers hold); dollar-quoted bodies are NOT blanked, because a `DO $$ … $$`
 * block can carry a denied statement (0021 renames constraints that way).
 * `UPDATE` counts only as a statement verb: `ON UPDATE` (FK actions) and
 * `ON CONFLICT DO UPDATE` (seed upserts) are not data migrations. That is
 * enough for this deny list; it is not a validator.
 *
 * Usage: node scripts/migration-guard.mjs [--base <ref>] [--census] [--folder <dir>]
 * Exit 0 clean; 1 on findings or a usage error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const ALLOW_MARKER = /--\s*migration-guard-allow:(.*)/;

const MIGRATION_FILE = /^\d{4}_.+\.sql$/;

/** [rule name, pattern]. Matched against the masked text of one statement. */
export const DENY_LIST = [
  ["DROP TABLE", /\bDROP\s+TABLE\b/i],
  // COLUMN is optional in Postgres: `ALTER TABLE t DROP "col"` drops a column too.
  ["DROP COLUMN", /\bDROP\s+COLUMN\b|\bDROP\s+(?:IF\s+EXISTS\s+)?"/i],
  ["DROP INDEX", /\bDROP\s+INDEX\b/i],
  ["RENAME", /\bRENAME\b/i],
  ["ALTER TYPE", /\bALTER\s+TYPE\b/i],
  [
    "ALTER COLUMN … TYPE",
    /\bALTER\s+(?:COLUMN\s+)?(?:"[^"]*"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/i,
  ],
  ["SET NOT NULL", /\bSET\s+NOT\s+NULL\b/i],
  ["TRUNCATE", /\bTRUNCATE\b/i],
  ["DELETE FROM", /\bDELETE\s+FROM\b/i],
  ["UPDATE", /(?<!\b(?:ON|DO)\s+)\bUPDATE\b/i],
];

/**
 * Splits SQL into statements and collects allow markers. Each statement has
 * the line and offset of its first token, the offset of its `;` (or EOF), and
 * a masked copy — same length as the original — for matching.
 */
export function scanSql(source) {
  const statements = [];
  const markers = [];
  const masked = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let start = -1;
  let startLine = 0;
  let dollarTag = null;

  const open = () => {
    if (start === -1) {
      start = i;
      startLine = line;
    }
  };
  const close = (end) => {
    if (start !== -1) statements.push({ line: startLine, start, end });
    start = -1;
  };

  while (i < n) {
    const ch = source[i];
    if (ch === "\n") {
      masked.push("\n");
      line++;
      i++;
      continue;
    }
    if (source.startsWith("--", i)) {
      const eol = source.indexOf("\n", i);
      const end = eol === -1 ? n : eol;
      const marker = ALLOW_MARKER.exec(source.slice(i, end));
      if (marker) markers.push({ line, offset: i, reason: marker[1].trim() });
      masked.push(" ".repeat(end - i));
      i = end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (source.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      for (let k = i; k < j; k++) {
        masked.push(source[k] === "\n" ? "\n" : " ");
        if (source[k] === "\n") line++;
      }
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      open();
      masked.push(ch);
      let j = i + 1;
      while (j < n) {
        if (source[j] === ch) {
          if (source[j + 1] !== ch) break;
          masked.push(" ", " "); // '' or "" escape
          j += 2;
          continue;
        }
        masked.push(source[j] === "\n" ? "\n" : " ");
        if (source[j] === "\n") line++;
        j++;
      }
      if (j < n) masked.push(ch);
      i = Math.min(j + 1, n);
      continue;
    }
    if (ch === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i, i + 64));
      if (tag) {
        if (dollarTag === null) dollarTag = tag[0];
        else if (tag[0] === dollarTag) dollarTag = null;
        open();
        masked.push(tag[0]);
        i += tag[0].length;
        continue;
      }
    }
    if (ch === ";" && dollarTag === null) {
      masked.push(";");
      close(i);
      i++;
      continue;
    }
    if (!/\s/.test(ch)) open();
    masked.push(ch);
    i++;
  }
  close(n);

  const maskedText = masked.join("");
  return {
    statements: statements.map((s) => ({
      ...s,
      text: source.slice(s.start, s.end),
      masked: maskedText.slice(s.start, s.end),
    })),
    markers,
  };
}

/**
 * Deny-list scan of one migration. `denied` lists every statement that
 * matches a rule, with the marker reason that excuses it (or null); `stale`
 * lists markers that excuse nothing. A marker belongs to the first statement
 * that ends after it, and each statement takes at most one marker.
 */
export function scanMigration(file, source) {
  const { statements, markers } = scanSql(source);
  const markerFor = new Map();
  markers.forEach((marker, mi) => {
    const si = statements.findIndex((s) => s.end > marker.offset);
    if (si !== -1 && !markerFor.has(si)) markerFor.set(si, mi);
  });
  const denied = [];
  const excusing = new Set();
  statements.forEach((s, si) => {
    const rules = DENY_LIST.filter(([, re]) => re.test(s.masked)).map(([name]) => name);
    if (rules.length === 0) return;
    const mi = markerFor.get(si);
    const reason = mi === undefined ? "" : markers[mi].reason;
    if (reason) excusing.add(mi);
    denied.push({ file, line: s.line, rules, allowed: reason || null });
  });
  const stale = markers.flatMap((marker, mi) => {
    if (excusing.has(mi)) return [];
    const why = marker.reason
      ? "no denied statement follows it"
      : "it has no reason after the colon";
    return [{ file, line: marker.line, why }];
  });
  return { denied, stale };
}

/** Journal-consistency problems, as `<file>[:line]: message` strings. */
export function checkJournal(folder) {
  const problems = [];
  const journalRel = "meta/_journal.json";
  const journalPath = path.join(folder, journalRel);
  if (!existsSync(journalPath)) return [`${journalRel}: missing`];
  const raw = readFileSync(journalPath, "utf8");
  const entries = JSON.parse(raw).entries ?? [];
  const lineOf = (tag) => {
    const at = raw.indexOf(`"tag": "${tag}"`);
    return at === -1 ? 1 : raw.slice(0, at).split("\n").length;
  };

  for (const name of readdirSync(folder).filter((f) => f.endsWith(".sql")).sort()) {
    if (!MIGRATION_FILE.test(name)) {
      problems.push(`${name}: migration files are named NNNN_<name>.sql`);
      continue;
    }
    const stem = name.slice(0, -".sql".length);
    const count = entries.filter((e) => e.tag === stem).length;
    if (count === 0) {
      problems.push(
        `${name}: no ${journalRel} entry with tag "${stem}" — the migrator only runs files the journal lists`,
      );
    } else if (count > 1) {
      problems.push(`${journalRel}:${lineOf(stem)}: ${count} entries share tag "${stem}"`);
    }
  }

  entries.forEach((entry, position) => {
    const where = `${journalRel}:${lineOf(entry.tag)}`;
    if (!existsSync(path.join(folder, `${entry.tag}.sql`))) {
      problems.push(`${where}: entry "${entry.tag}" has no ${entry.tag}.sql`);
    }
    if (entry.idx !== position) {
      problems.push(
        `${where}: idx ${entry.idx} at position ${position} — idx must run contiguously from 0 (a parallel lane may already hold this number)`,
      );
    }
    const prefix = String(entry.tag).slice(0, 4);
    if (Number(prefix) !== entry.idx) {
      problems.push(`${where}: tag prefix ${prefix} does not match idx ${entry.idx}`);
    }
    if (typeof entry.when !== "number") {
      problems.push(
        `${where}: when must be a number (epoch ms), got ${JSON.stringify(entry.when)}`,
      );
      return;
    }
    const prev = entries[position - 1];
    if (prev && !(entry.when > prev.when)) {
      problems.push(
        `${where}: when ${entry.when} is not greater than the previous entry's ${prev.when} — the migrator applies only entries whose when exceeds the last applied one, so this migration would silently never run in prod`,
      );
    }
  });
  const last = entries[entries.length - 1];
  if (last && entries.some((e) => e.when > last.when)) {
    problems.push(
      `${journalRel}:${lineOf(last.tag)}: the highest-idx entry "${last.tag}" does not have the highest when`,
    );
  }
  return problems;
}

/** Every deny-list match in every migration of `folder`, in file order. */
export function census(folder) {
  return readdirSync(folder)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .flatMap(
      (name) => scanMigration(name, readFileSync(path.join(folder, name), "utf8")).denied,
    );
}

/**
 * Migrations added or changed since `base`, as repo-root-relative paths. The
 * working tree is compared, so an uncommitted or untracked migration counts.
 * With history available the diff starts at the merge base (a migration that
 * landed on main meanwhile is not attributed to the branch); a shallow CI
 * clone has none, and the diff is then against the base tip's tree — exact
 * for GitHub's PR merge commit, empty on a push to main itself.
 */
export function changedMigrations(folder, base) {
  const git = (...args) =>
    execFileSync("git", ["-C", folder, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const root = git("rev-parse", "--show-toplevel");
  try {
    git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  } catch {
    throw new Error(
      `base ref "${base}" not found — run \`git fetch origin main\` or pass --base <ref>`,
    );
  }
  let from = base;
  try {
    from = git("merge-base", base, "HEAD");
  } catch {
    // shallow clone: no merge base
  }
  const changed = git("diff", "--name-only", "--no-renames", "--diff-filter=AM", from, "--", ".");
  const untracked = git("ls-files", "--others", "--exclude-standard", "--full-name", "--", ".");
  const files = `${changed}\n${untracked}`
    .split("\n")
    .filter((f) => MIGRATION_FILE.test(path.basename(f)));
  return { root, files };
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string", default: "origin/main" },
      census: { type: "boolean", default: false },
      folder: { type: "string" },
    },
  });
  const folder = path.resolve(
    values.folder ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle"),
  );
  const root = execFileSync("git", ["-C", folder, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const rel = (f) => path.relative(root, path.join(folder, f)).split(path.sep).join("/");

  if (values.census) {
    const hits = census(folder);
    const files = new Set(hits.map((h) => h.file)).size;
    console.log(
      `migration guard census: ${hits.length} deny-list statement(s) across ${files} file(s)`,
    );
    for (const hit of hits) {
      const allowed = hit.allowed ? `  [allowed: ${hit.allowed}]` : "";
      console.log(`${rel(hit.file)}:${hit.line}  ${hit.rules.join(", ")}${allowed}`);
    }
    return 0;
  }

  const findings = checkJournal(folder).map((problem) => {
    const [file, ...rest] = problem.split(": ");
    return `${rel(file)}: ${rest.join(": ")}`;
  });

  const { files } = changedMigrations(folder, values.base);
  for (const file of files) {
    const { denied, stale } = scanMigration(file, readFileSync(path.join(root, file), "utf8"));
    for (const hit of denied) {
      if (hit.allowed) continue;
      findings.push(
        `${file}:${hit.line}: ${hit.rules.join(", ")} is not additive — excuse it with "-- migration-guard-allow: <reason>" on the line above (review then routes it to a human), or split it into an expand/contract pair (packages/db/README.md)`,
      );
    }
    for (const marker of stale) {
      findings.push(`${file}:${marker.line}: stale migration-guard-allow marker — ${marker.why}`);
    }
  }

  const scope =
    files.length === 0
      ? "no migrations changed"
      : `${files.length} changed migration(s): ${files.map((f) => path.basename(f)).join(", ")}`;
  if (findings.length === 0) {
    console.log(`migration guard: ok (journal consistent; ${scope} vs ${values.base})`);
    return 0;
  }
  console.error(`migration guard: ${findings.length} finding(s) (${scope} vs ${values.base})`);
  for (const finding of findings) console.error(finding);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`migration guard: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
