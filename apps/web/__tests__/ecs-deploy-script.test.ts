import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../infra/scripts/deploy-ecs-stack.sh", import.meta.url),
);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("deploy-ecs-stack.sh", () => {
  it("applies CDK before waiting for and recording all three services", () => {
    const result = runScript();

    expect(result.status).toBe(0);
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).toContain(
      // #449: deploys pin the commit-SHA tag via the ImageTag parameter.
      "pnpm --filter @ai-workspace/infra exec cdk deploy AiWorkspaceEcsStack --require-approval never --parameters ImageTag=commit-sha --exclusively",
    );
    expect(commands).not.toContain("ecs update-service");
    const services = [
      "ai-workspace-web",
      "ai-workspace-chat-worker",
      "ai-workspace-memory-worker",
    ];
    expect(commands).toContain(`--services ${services.join(" ")}`);
    for (const service of services) {
      expect(result.stdout).toContain(service);
    }
    expect(commands.indexOf("ecs wait services-stable")).toBeLessThan(
      commands.indexOf("ecs describe-services"),
    );
    expect(result.stdout).toContain('"commitSha":"commit-sha"');
    expect(result.stdout).toContain('"taskDefinition"');
  });

  it("does not recycle services when CDK reports no changes", () => {
    const result = runScript({ cdkNoChanges: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no changes");
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).not.toContain("ecs update-service");
    expect(commands).toContain("ecs wait services-stable");
  });

  it("fails closed before ECS wait when CDK deployment fails", () => {
    const result = runScript({ cdkFailure: true });

    expect(result.status).not.toBe(0);
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "ecs wait services-stable",
    );
  });

  it("fails closed without a receipt when services do not stabilize", () => {
    const result = runScript({ waitFailure: true });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Deployment receipt");
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "ecs describe-services",
    );
  });

  it("runs from buildspec after image pushes and before production smoke", () => {
    const buildspec = readFileSync(join(ROOT, "buildspec.yml"), "utf8");
    const deploy = buildspec.indexOf("deploy-ecs-stack.sh");

    expect(buildspec).toContain("nodejs: 20");
    expect(buildspec).toContain("pnpm@9.12.3");
    expect(buildspec).toContain(
      'export CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID"',
    );
    expect(buildspec).toContain(
      'export CDK_DEFAULT_REGION="$AWS_DEFAULT_REGION"',
    );
    expect(buildspec).toContain(
      "pnpm --filter @ai-workspace/infra install --frozen-lockfile",
    );
    expect(deploy).toBeGreaterThan(buildspec.indexOf("docker push"));
    expect(deploy).toBeLessThan(
      buildspec.indexOf("Running authenticated production smoke"),
    );
  });
});

function runScript({
  cdkFailure = false,
  cdkNoChanges = false,
  waitFailure = false,
}: {
  cdkFailure?: boolean;
  cdkNoChanges?: boolean;
  waitFailure?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ecs-deploy-script-"));
  tempDirs.push(dir);
  const capturePath = join(dir, "commands.txt");
  const pnpmPath = join(dir, "pnpm");
  const awsPath = join(dir, "aws");

  writeFileSync(
    pnpmPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\n' "$*" >> "$FAKE_CAPTURE_PATH"
if [[ "$FAKE_CDK_FAILURE" == "1" ]]; then
  echo "simulated CDK failure" >&2
  exit 1
fi
if [[ "$FAKE_CDK_NO_CHANGES" == "1" ]]; then
  echo "AiWorkspaceEcsStack: no changes"
fi
`,
  );
  chmodSync(pnpmPath, 0o755);

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\n' "$*" >> "$FAKE_CAPTURE_PATH"

if [[ "$1 $2 $3" == "ecs wait services-stable" && "$FAKE_WAIT_FAILURE" == "1" ]]; then
  echo "simulated stabilization failure" >&2
  exit 1
fi

if [[ "$1 $2" == "ecs describe-services" ]]; then
  cat <<'JSON'
[
  {"service":"ai-workspace-web","taskDefinition":"arn:task/ai-workspace-web:42"},
  {"service":"ai-workspace-chat-worker","taskDefinition":"arn:task/ai-workspace-chat-worker:31"},
  {"service":"ai-workspace-memory-worker","taskDefinition":"arn:task/ai-workspace-memory-worker:27"}
]
JSON
fi
`,
  );
  chmodSync(awsPath, 0o755);

  const result = spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AWS_DEFAULT_REGION: "us-east-1",
      COMMIT_TAG: "commit-sha",
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_CDK_FAILURE: cdkFailure ? "1" : "0",
      FAKE_CDK_NO_CHANGES: cdkNoChanges ? "1" : "0",
      FAKE_WAIT_FAILURE: waitFailure ? "1" : "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
  };
}
