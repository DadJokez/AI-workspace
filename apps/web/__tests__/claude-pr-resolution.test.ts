import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../.github/scripts/resolve-exact-head-pr.mjs", import.meta.url),
);

function pull(number: number, headSha: string, containedShas = [headSha]) {
  return {
    number,
    state: "open",
    head: { sha: headSha },
    containedShas,
  };
}

function resolve(pages: unknown, sha: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH, sha], {
    encoding: "utf8",
    input: JSON.stringify(pages),
  });
}

describe("Claude review exact-head PR resolution", () => {
  it("resolves one independent open PR", () => {
    const result = resolve([[pull(41, "sha-independent")]], "sha-independent");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("41");
  });

  it("resolves the lower PR in a four-PR stack by exact head SHA", () => {
    const lowerSha = "sha-lower";
    const result = resolve(
      [
        [
          pull(101, lowerSha),
          pull(102, "sha-middle-1", [lowerSha, "sha-middle-1"]),
        ],
        [
          pull(103, "sha-middle-2", [
            lowerSha,
            "sha-middle-1",
            "sha-middle-2",
          ]),
          pull(104, "sha-upper", [
            lowerSha,
            "sha-middle-1",
            "sha-middle-2",
            "sha-upper",
          ]),
        ],
      ],
      lowerSha,
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("101");
  });

  it("fails closed when no open PR has the exact head SHA", () => {
    const result = resolve([[pull(201, "different-sha")]], "missing-sha");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("found 0");
  });

  it("fails closed when more than one open PR has the exact head SHA", () => {
    const result = resolve(
      [[pull(301, "duplicate-sha"), pull(302, "duplicate-sha")]],
      "duplicate-sha",
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("found 2");
  });
});
