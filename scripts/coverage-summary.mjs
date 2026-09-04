// Per-package unit-test coverage table, read from the `json-summary` files that
// `pnpm test:coverage` writes (<package>/coverage/coverage-summary.json).
// Prints Markdown to stdout and, under GitHub Actions, appends the same table
// to the run's summary page via GITHUB_STEP_SUMMARY.
//
// Report-only (#695): no thresholds and never a failing exit. A package that
// declares `test:coverage` but produced no summary is listed as "missing"
// rather than dropped, so a silently broken coverage run stays visible.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
// Mirrors the globs in pnpm-workspace.yaml.
const WORKSPACE_DIRS = ["apps", "infra", "packages"];
const METRICS = ["lines", "branches", "functions", "statements"];

function coveragePackages() {
  const found = [];
  for (const dir of WORKSPACE_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const manifest = path.join(abs, name, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.scripts?.["test:coverage"]) found.push(`${dir}/${name}`);
    }
  }
  return found.sort();
}

function pct(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

function row(pkgDir) {
  const summaryPath = path.join(repoRoot, pkgDir, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    return `| \`${pkgDir}\` | ${METRICS.map(() => "missing").join(" | ")} |`;
  }
  const { total } = JSON.parse(readFileSync(summaryPath, "utf8"));
  return `| \`${pkgDir}\` | ${METRICS.map((metric) => pct(total?.[metric]?.pct)).join(" | ")} |`;
}

const table = [
  "| Package | Lines | Branches | Functions | Statements |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...coveragePackages().map(row),
].join("\n");

console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Unit test coverage (report-only)\n\n${table}\n`);
}
