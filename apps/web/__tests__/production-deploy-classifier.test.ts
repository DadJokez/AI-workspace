import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL(
    "../../../infra/scripts/classify-production-deploy.sh",
    import.meta.url,
  ),
);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("classify-production-deploy.sh", () => {
  it("skips an unambiguous docs-only push and logs every changed path", () => {
    const repo = createRepo();
    const previous = commitFiles(repo, {
      "README.md": "before\n",
      "docs/guide.md": "before\n",
    });
    const current = commitFiles(repo, {
      "README.md": "after\n",
      "docs/guide.md": "after\n",
    });

    const result = classify(repo, previous, current);

    expect(result.status).toBe(0);
    expect(result.decision).toBe("SKIP_PRODUCTION_DEPLOY=1\n");
    expect(result.stdout).toContain("docs-only: deployment skipped");
    expect(result.stdout).toContain("README.md");
    expect(result.stdout).toContain("docs/guide.md");
  });

  it("requires a deploy for a runtime change", () => {
    const repo = createRepo();
    const previous = commitFiles(repo, { "apps/web/app.ts": "before\n" });
    const current = commitFiles(repo, { "apps/web/app.ts": "after\n" });

    const result = classify(repo, previous, current);

    expect(result.status).toBe(0);
    expect(result.decision).toBe("SKIP_PRODUCTION_DEPLOY=0\n");
    expect(result.stdout).toContain("apps/web/app.ts");
  });

  it("requires a deploy for mixed documentation and runtime changes", () => {
    const repo = createRepo();
    const previous = commitFiles(repo, {
      "docs/guide.md": "before\n",
      "packages/agent/index.ts": "before\n",
    });
    const current = commitFiles(repo, {
      "docs/guide.md": "after\n",
      "packages/agent/index.ts": "after\n",
    });

    const result = classify(repo, previous, current);

    expect(result.decision).toBe("SKIP_PRODUCTION_DEPLOY=0\n");
    expect(result.stdout).toContain("one or more changed paths");
  });

  it("requires a deploy for a manual build", () => {
    const repo = createRepo();
    const previous = commitFiles(repo, { "docs/guide.md": "before\n" });
    const current = commitFiles(repo, { "docs/guide.md": "after\n" });

    const result = classify(repo, previous, current, { webhookEvent: "" });

    expect(result.decision).toBe("SKIP_PRODUCTION_DEPLOY=0\n");
    expect(result.stdout).toContain("not triggered by a push webhook");
  });

  it("requires a deploy for an initial push without a previous SHA", () => {
    const repo = createRepo();
    const current = commitFiles(repo, { "docs/guide.md": "after\n" });

    const result = classify(repo, "0".repeat(40), current);

    expect(result.decision).toBe("SKIP_PRODUCTION_DEPLOY=0\n");
    expect(result.stdout).toContain("has no previous commit");
  });

  it("requires a deploy when the previous commit cannot be resolved", () => {
    const repo = createRepo();
    commitFiles(repo, { "docs/guide.md": "before\n" });
    const current = commitFiles(repo, { "docs/guide.md": "after\n" });

    const result = classify(repo, "f".repeat(40), current);

    expect(result.decision).toBe("SKIP_PRODUCTION_DEPLOY=0\n");
    expect(result.stdout).toContain("previous commit could not be fetched");
  });

  it("guards every expensive build phase before deployment work", () => {
    const buildspec = readFileSync(join(ROOT, "buildspec.yml"), "utf8");

    expect(buildspec).toContain("classify-production-deploy.sh");
    expect(buildspec.match(/SKIP_PRODUCTION_DEPLOY/g)?.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(buildspec.indexOf("classify-production-deploy.sh")).toBeLessThan(
      buildspec.indexOf("pnpm --filter @ai-workspace/infra install"),
    );
    expect(buildspec.indexOf("Skipping pre-build for docs-only change")).toBeLessThan(
      buildspec.indexOf("Logging in to Amazon ECR"),
    );
    expect(buildspec.indexOf("Skipping image builds for docs-only change")).toBeLessThan(
      buildspec.indexOf("docker build"),
    );
    expect(buildspec.indexOf("Skipping deployment for docs-only change")).toBeLessThan(
      buildspec.indexOf("Running database migrations"),
    );
  });
});

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "production-deploy-classifier-"));
  tempDirs.push(dir);
  runGit(dir, ["init", "--quiet"]);
  runGit(dir, ["config", "user.email", "tests@example.com"]);
  runGit(dir, ["config", "user.name", "Tests"]);
  return dir;
}

function commitFiles(repo: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    const absolutePath = join(repo, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "--quiet", "-m", "test fixture"]);
  return runGit(repo, ["rev-parse", "HEAD"]).stdout.trim();
}

function classify(
  repo: string,
  previous: string,
  current: string,
  { webhookEvent = "PUSH" }: { webhookEvent?: string } = {},
) {
  const decisionPath = join(repo, "decision.env");
  const result = spawnSync("bash", [SCRIPT_PATH, decisionPath], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEBUILD_WEBHOOK_EVENT: webhookEvent,
      CODEBUILD_WEBHOOK_TRIGGER: "branch/main",
      CODEBUILD_WEBHOOK_PREV_COMMIT: previous,
      CODEBUILD_RESOLVED_SOURCE_VERSION: current,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    decision: readFileSync(decisionPath, "utf8"),
  };
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}
