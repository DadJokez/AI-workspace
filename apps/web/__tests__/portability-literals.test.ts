import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Values that tie the code to one account, domain or repository. */
const DEPLOYMENT_LITERALS = [
  "351478076796",
  "builtwithrobot",
  "DadJokez/AI-workspace",
];

/**
 * Files still allowed to carry them. Documents and test fixtures stay; the
 * infrastructure and pipeline entries are the to-do list for the Koch
 * migration (docs/roadmap/KOCH_MIGRATION_SPEC.md), which WP-20 shrinks.
 */
const EXCLUDED: RegExp[] = [
  // Documents and plans.
  /^docs\//,
  /^specs\//,
  /^\.agents\//,
  // Tests and their fixtures.
  /\/__tests__\//,
  /\.test\./,
  /\.spec\./,
  // Today's deployment of the personal account, replaced by Terraform.
  /^infra\/cdk\//,
  /^infra\/scripts\//,
  /^buildspec[^/]*\.yml$/,
  /^\.github\/workflows\//,
  // Applied migrations are immutable. 0053 rewrites what the other three seeded.
  /^packages\/db\/drizzle\/00(32|35|40|53)_/,
];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

describe("deployment portability", () => {
  it("keeps account, domain and repository literals out of portable code", () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (EXCLUDED.some((pattern) => pattern.test(file))) continue;
      let content: string;
      try {
        content = readFileSync(path.join(REPO_ROOT, file), "utf8");
      } catch {
        continue; // deleted in the working tree, or a submodule entry
      }
      for (const literal of DEPLOYMENT_LITERALS) {
        if (content.includes(literal)) offenders.push(`${file}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still needs every exclusion", () => {
    const files = trackedFiles();
    const unused = EXCLUDED.filter(
      (pattern) => !files.some((file) => pattern.test(file)),
    ).map(String);
    expect(unused).toEqual([]);
  });
});
