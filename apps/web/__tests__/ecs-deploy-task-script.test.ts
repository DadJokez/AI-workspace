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
  new URL("../../../infra/scripts/run-ecs-deploy-task.sh", import.meta.url),
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("run-ecs-deploy-task.sh", () => {
  it.each([
    ["migrate", "arn:task-definition/migrator:7"],
    ["smoke", "arn:task-definition/smoke:8"],
  ])("runs %s inside the stack network and emits a receipt", (kind, task) => {
    const result = runScript(kind);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`\"kind\":\"${kind}\"`);
    expect(result.stdout).toContain('"commitSha":"commit-sha"');
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).toContain(`--task-definition ${task}`);
    expect(commands).toContain("--launch-type FARGATE");
    expect(commands).toContain("subnets=[subnet-a,subnet-b]");
    expect(commands).toContain("securityGroups=[sg-deploy]");
    expect(commands).toContain("assignPublicIp=ENABLED");
    expect(commands.indexOf("ecs wait tasks-stopped")).toBeLessThan(
      commands.indexOf("ecs describe-tasks"),
    );
  });

  it("fails closed when ECS rejects the task", () => {
    const result = runScript("migrate", { runFailure: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ECS rejected the deploy task");
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "ecs wait tasks-stopped",
    );
  });

  it("fails closed when the task does not stop cleanly", () => {
    const result = runScript("smoke", { waitFailure: true });

    expect(result.status).not.toBe(0);
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "ecs describe-tasks",
    );
  });

  it("fails closed on a non-zero container exit", () => {
    const result = runScript("migrate", { exitCode: 17 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("migrate task failed with exit code 17");
    expect(result.stdout).not.toContain("Deploy task receipt");
  });

  it("rejects unknown task kinds before calling AWS", () => {
    const result = runScript("unknown");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(readFileSync(result.capturePath, "utf8")).toBe("");
  });
});

function runScript(
  kind: string,
  {
    runFailure = false,
    waitFailure = false,
    exitCode = 0,
  }: { runFailure?: boolean; waitFailure?: boolean; exitCode?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ecs-deploy-task-script-"));
  tempDirs.push(dir);
  const capturePath = join(dir, "commands.txt");
  writeFileSync(capturePath, "");
  const awsPath = join(dir, "aws");
  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\n' "$*" >> "$FAKE_CAPTURE_PATH"

if [[ "$1 $2" == "cloudformation describe-stacks" ]]; then
  cat <<'JSON'
[
  {"OutputKey":"MigratorTaskDefinitionArn","OutputValue":"arn:task-definition/migrator:7"},
  {"OutputKey":"ProductionSmokeTaskDefinitionArn","OutputValue":"arn:task-definition/smoke:8"},
  {"OutputKey":"DeployTaskSecurityGroupId","OutputValue":"sg-deploy"},
  {"OutputKey":"DeployTaskSubnetIds","OutputValue":"subnet-a,subnet-b"}
]
JSON
elif [[ "$1 $2" == "ecs run-task" ]]; then
  if [[ "$FAKE_RUN_FAILURE" == "1" ]]; then
    printf '{"tasks":[],"failures":[{"reason":"ACCESS_DENIED"}]}\n'
  else
    printf '{"tasks":[{"taskArn":"arn:task/deploy-123"}],"failures":[]}\n'
  fi
elif [[ "$1 $2 $3" == "ecs wait tasks-stopped" ]]; then
  if [[ "$FAKE_WAIT_FAILURE" == "1" ]]; then
    echo "simulated waiter failure" >&2
    exit 1
  fi
elif [[ "$1 $2" == "ecs describe-tasks" ]]; then
  printf '{"tasks":[{"taskArn":"arn:task/deploy-123","taskDefinitionArn":"arn:task-definition/current:9","stoppedReason":"Essential container exited","containers":[{"name":"deploy","exitCode":%s}]}]}\n' "$FAKE_EXIT_CODE"
else
  echo "unexpected aws command: $*" >&2
  exit 99
fi
`,
  );
  chmodSync(awsPath, 0o755);

  const result = spawnSync("bash", [SCRIPT_PATH, kind], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AWS_DEFAULT_REGION: "us-east-1",
      COMMIT_TAG: "commit-sha",
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_RUN_FAILURE: runFailure ? "1" : "0",
      FAKE_WAIT_FAILURE: waitFailure ? "1" : "0",
      FAKE_EXIT_CODE: String(exitCode),
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
  };
}
