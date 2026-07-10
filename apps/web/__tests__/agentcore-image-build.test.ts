import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../infra/scripts/agentcore-image-build.sh", import.meta.url),
);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agentcore-image-build.sh", () => {
  it("starts a native ARM child build for the exact source commit", () => {
    const result = runScript(["start"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ai-workspace-build:child-id");
    const command = readFileSync(result.capturePath, "utf8");
    expect(command).toContain("--source-version commit-sha");
    expect(command).toContain("--buildspec-override buildspec.agentcore.yml");
    expect(command).toContain("--environment-type-override ARM_CONTAINER");
    expect(command).toContain(
      "--image-override aws/codebuild/amazonlinux-aarch64-standard:3.0",
    );
    expect(command).toContain("--no-report-build-status-override");
    expect(command).toContain(
      "name=AGENTCORE_COMMIT_TAG,value=commit-sha,type=PLAINTEXT",
    );
  });

  it("waits through an in-progress build until it succeeds", () => {
    const result = runScript(["wait", "ai-workspace-build:child-id"], {
      statuses: "IN_PROGRESS,SUCCEEDED",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("succeeded");
  });

  it("fails the parent deploy when the ARM child build fails", () => {
    const result = runScript(["wait", "ai-workspace-build:child-id"], {
      statuses: "FAILED",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ended with FAILED");
    expect(result.stderr).toContain("https://logs.example/child");
  });

  it("keeps Docker Hub and QEMU emulation out of the deploy path", () => {
    const parentBuildspec = readFileSync(join(ROOT, "buildspec.yml"), "utf8");
    const armBuildspec = readFileSync(
      join(ROOT, "buildspec.agentcore.yml"),
      "utf8",
    );
    const dockerfile = readFileSync(
      join(ROOT, "apps/agentcore-agent/Dockerfile"),
      "utf8",
    );

    expect(parentBuildspec).not.toContain("tonistiigi/binfmt");
    expect(parentBuildspec).not.toContain("docker buildx");
    expect(parentBuildspec).toContain(
      "export COMMIT_TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION:-manual}",
    );
    expect(parentBuildspec).toContain("agentcore-image-build.sh start");
    expect(parentBuildspec).toContain("agentcore-image-build.sh wait");
    expect(armBuildspec).toContain('test "$(uname -m)" = "aarch64"');
    expect(dockerfile).toContain("public.ecr.aws/docker/library/node");
  });
});

function runScript(
  args: string[],
  { statuses = "SUCCEEDED" }: { statuses?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-image-build-"));
  tempDirs.push(dir);
  const awsPath = join(dir, "aws");
  const capturePath = join(dir, "start-command.txt");
  const counterPath = join(dir, "poll-count.txt");
  writeFileSync(counterPath, "0");

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1 $2" == "codebuild start-build" ]]; then
  printf '%s\n' "$*" > "$FAKE_CAPTURE_PATH"
  printf 'ai-workspace-build:child-id\n'
  exit 0
fi

if [[ "$1 $2" == "codebuild batch-get-builds" ]]; then
  if [[ "$*" == *"logs.deepLink"* ]]; then
    printf 'https://logs.example/child\n'
    exit 0
  fi

  count=$(cat "$FAKE_COUNTER_PATH")
  IFS=',' read -r -a values <<< "$FAKE_STATUSES"
  index=$count
  if (( index >= \${#values[@]} )); then
    index=$((\${#values[@]} - 1))
  fi
  printf '%s\n' "\${values[$index]}"
  printf '%s' "$((count + 1))" > "$FAKE_COUNTER_PATH"
  exit 0
fi

echo "unexpected fake aws command: $*" >&2
exit 1
`,
  );
  chmodSync(awsPath, 0o755);

  const result = spawnSync("bash", [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AWS_DEFAULT_REGION: "us-east-1",
      AGENTCORE_BUILD_PROJECT_NAME: "ai-workspace-build",
      AGENTCORE_IMAGE_REPO_NAME: "ai-workspace-agentcore-agent",
      AGENTCORE_BUILD_POLL_SECONDS: "0",
      AGENTCORE_BUILD_MAX_POLLS: "3",
      CODEBUILD_RESOLVED_SOURCE_VERSION: "commit-sha",
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_COUNTER_PATH: counterPath,
      FAKE_STATUSES: statuses,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
  };
}
