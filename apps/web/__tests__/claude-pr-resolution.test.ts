import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../.github/scripts/resolve-exact-head-pr.mjs", import.meta.url),
);
const WORKFLOW_PATH = fileURLToPath(
  new URL("../../../.github/workflows/claude-code-review.yml", import.meta.url),
);

function pull(
  number: number,
  headRefName: string,
  headSha: string,
  containedShas = [headSha],
  state = "open",
) {
  return {
    number,
    state,
    head: { ref: headRefName, sha: headSha },
    containedShas,
  };
}

function resolve(pages: unknown, sha: string, headRefName?: string) {
  const args = [SCRIPT_PATH, sha];
  if (headRefName) args.push(headRefName);
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    input: JSON.stringify(pages),
  });
}

function resolution(result: ReturnType<typeof resolve>) {
  return JSON.parse(result.stdout) as {
    ok: boolean;
    pr?: number;
    code?: string;
    reason?: string;
    candidates?: Array<{
      number: number;
      headRefName: string;
      headSha: string;
    }>;
  };
}

describe("Claude review exact-head PR resolution", () => {
  it("resolves one independent open PR", () => {
    const result = resolve(
      [[pull(41, "codex/independent", "sha-independent")]],
      "sha-independent",
      "codex/independent",
    );

    expect(result.status).toBe(0);
    expect(resolution(result)).toMatchObject({ ok: true, pr: 41 });
  });

  it("keeps multiple independent pull requests isolated", () => {
    const result = resolve(
      [
        [
          pull(51, "codex/one", "sha-one"),
          pull(52, "codex/two", "sha-two"),
        ],
      ],
      "sha-two",
      "codex/two",
    );

    expect(result.status).toBe(0);
    expect(resolution(result)).toMatchObject({ ok: true, pr: 52 });
  });

  it("resolves the lower PR in a four-PR stack by exact head SHA", () => {
    const lowerSha = "sha-lower";
    const result = resolve(
      [
        [
          pull(101, "codex/lower", lowerSha),
          pull(102, "codex/middle-1", "sha-middle-1", [
            lowerSha,
            "sha-middle-1",
          ]),
        ],
        [
          pull(103, "codex/middle-2", "sha-middle-2", [
            lowerSha,
            "sha-middle-1",
            "sha-middle-2",
          ]),
          pull(104, "codex/upper", "sha-upper", [
            lowerSha,
            "sha-middle-1",
            "sha-middle-2",
            "sha-upper",
          ]),
        ],
      ],
      lowerSha,
      "codex/lower",
    );

    expect(result.status).toBe(0);
    expect(resolution(result)).toMatchObject({ ok: true, pr: 101 });
  });

  it("prefers the exact branch when open PRs share a head SHA", () => {
    const result = resolve(
      [
        [
          pull(201, "codex/shared-one", "shared-sha"),
          pull(202, "codex/shared-two", "shared-sha"),
        ],
      ],
      "shared-sha",
      "codex/shared-two",
    );

    expect(result.status).toBe(0);
    expect(resolution(result)).toMatchObject({ ok: true, pr: 202 });
  });

  it("fails closed when an updated branch no longer has the workflow SHA", () => {
    const result = resolve(
      [[pull(301, "codex/updated", "new-sha")]],
      "old-sha",
      "codex/updated",
    );

    expect(result.status).toBe(2);
    expect(resolution(result)).toMatchObject({
      ok: false,
      code: "stale_head_sha",
      reason: "Branch codex/updated no longer points at workflow SHA old-sha.",
      candidates: [
        {
          number: 301,
          headRefName: "codex/updated",
          headSha: "new-sha",
        },
      ],
    });
  });

  it("fails closed with candidates when exact branch and SHA stay ambiguous", () => {
    const result = resolve(
      [
        [
          pull(401, "codex/duplicate", "duplicate-sha"),
          pull(402, "codex/duplicate", "duplicate-sha"),
        ],
      ],
      "duplicate-sha",
      "codex/duplicate",
    );

    expect(result.status).toBe(2);
    expect(resolution(result)).toMatchObject({
      ok: false,
      code: "ambiguous_exact_head",
      candidates: [{ number: 401 }, { number: 402 }],
    });
  });

  it("does not attach a verdict to another branch with the same SHA", () => {
    const result = resolve(
      [[pull(501, "codex/other", "same-sha")]],
      "same-sha",
      "codex/intended",
    );

    expect(result.status).toBe(2);
    expect(resolution(result)).toMatchObject({
      ok: false,
      code: "head_branch_mismatch",
      candidates: [{ number: 501 }],
    });
  });

  it("classifies a closed or merged PR as a benign no-open-PR outcome", () => {
    const result = resolve(
      [[pull(601, "codex/merged", "merged-sha", undefined, "closed")]],
      "merged-sha",
      "codex/merged",
    );

    expect(result.status).toBe(2);
    expect(resolution(result)).toEqual({
      ok: false,
      code: "no_open_pull_request",
      reason:
        "No open pull request matches codex/merged at merged-sha.",
      candidates: [],
    });
  });

  it("skips the closed or merged case before the workflow can write a failure verdict", () => {
    // #699 split this workflow into a `review` job (runs the model, holds NO
    // statuses:write) and a model-free `publish-verdict` job. So this can no
    // longer be checked by string order in one script — assert the invariant
    // across both jobs: a PR that closed or merged mid-run must leave the
    // authenticated success alone and write no failure verdict.
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    // 1. The review job recognizes the closed/merged case and stops early.
    const guard = workflow.indexOf("if jq -e '.code == \"no_open_pull_request\"'");
    expect(guard).toBeGreaterThan(-1);
    const guardBlock = workflow.slice(guard, guard + 400);
    expect(guardBlock).toContain('go=false');
    expect(guardBlock).toContain("exit 0");

    // 2. Critically, it does NOT mark the run as a resolution failure — that
    //    flag is what makes the publisher write a red verdict.
    expect(guardBlock).not.toContain("resolution_failed=true");

    // 3. With no review outcome, the publisher exits before publishing.
    const publishJob = workflow.slice(workflow.indexOf("  publish-verdict:"));
    const noOutcome = publishJob.indexOf("No review outcome to publish");
    expect(noOutcome).toBeGreaterThan(-1);
    expect(publishJob.slice(noOutcome, noOutcome + 120)).toContain("exit 0");

    // 4. The publisher is the only job that can write a status, so a
    //    prompt-injected review session cannot green its own verdict (#698).
    //    Read the permissions BLOCKS, not the file text — the review job's
    //    header explains "Deliberately NO `statuses: write`", and a naive
    //    substring match scores that prose as the grant it warns about.
    const permissionsOf = (job: string) => {
      const start = workflow.indexOf(`  ${job}:`);
      const block = workflow.slice(start, workflow.indexOf("\n    steps:", start));
      const perms = block.indexOf("permissions:");
      if (perms === -1) return "";
      // Permission entries are the indented lines directly under the key.
      return block
        .slice(perms)
        .split("\n")
        .slice(1)
        .filter((line) => /^\s{6}\S/.test(line))
        // Drop comments: the review job documents its own absent grant as
        // "Deliberately NO `statuses: write`" INSIDE this block, and matching
        // that prose would read the warning as the permission.
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
    };

    expect(permissionsOf("review")).not.toMatch(/statuses:\s*write/);
    expect(permissionsOf("publish-verdict")).toMatch(/statuses:\s*write/);
  });
});
