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

// infra/terraform/scripts/run-task.sh replaces infra/scripts/run-ecs-deploy-task.sh
// for the Terraform pipeline; tested the same way, against a stubbed `aws`.
const SCRIPT_PATH = fileURLToPath(
  new URL("../../../infra/terraform/scripts/run-task.sh", import.meta.url),
);
const RELEASE_ID = "0123456789abcdef0123456789abcdef01234567";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PARAMETERS = {
  "/comparative/personal-stage/30-platform/cluster_arn":
    "arn:aws:ecs:us-east-1:111122223333:cluster/cmp-personal-stage",
  "/comparative/personal-stage/10-network/app_subnet_ids": '["subnet-a","subnet-b"]',
  "/comparative/personal-stage/10-network/sg/deploy_task_id": "sg-deploy",
  "/comparative/personal-stage/35-deploy-tasks/taskdef/migrator_arn":
    "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-personal-stage-migrator:7",
  "/comparative/personal-stage/35-deploy-tasks/taskdef/smoke_arn":
    "arn:aws:ecs:us-east-1:111122223333:task-definition/cmp-personal-stage-smoke:8",
};

describe("infra/terraform/scripts/run-task.sh", () => {
  it.each([
    ["migrator", "cmp-personal-stage-migrator:7"],
    ["smoke", "cmp-personal-stage-smoke:8"],
  ])(
    "runs %s from the SSM parameters in the private subnets and prints a receipt",
    (task, taskDefinition) => {
      const result = runScript(["personal-stage", task]);

      expect(result.status, result.stderr).toBe(0);
      const commands = readFileSync(result.capturePath, "utf8");
      expect(commands).toContain("ssm get-parameters");
      expect(commands).toContain(
        `/comparative/personal-stage/35-deploy-tasks/taskdef/${task}_arn`,
      );
      expect(commands).toContain(`--task-definition arn:aws:ecs:us-east-1:111122223333:task-definition/${taskDefinition}`);
      expect(commands).toContain("--cluster arn:aws:ecs:us-east-1:111122223333:cluster/cmp-personal-stage");
      expect(commands).toContain("--launch-type FARGATE");
      expect(commands).toContain(
        "awsvpcConfiguration={subnets=[subnet-a,subnet-b],securityGroups=[sg-deploy],assignPublicIp=DISABLED}",
      );
      expect(commands).not.toContain("assignPublicIp=ENABLED");
      expect(commands).toContain(`--started-by deploy-${task}-0123456789ab`);
      expect(commands.indexOf("ecs wait tasks-stopped")).toBeLessThan(
        commands.indexOf("ecs describe-tasks"),
      );
      const receipt = receiptOf(result.stdout);
      expect(receipt).toEqual({
        task,
        release_id: RELEASE_ID,
        task_arn: "arn:task/deploy-123",
        task_definition_arn: "arn:task-definition/current:9",
        exit_code: 0,
      });
    },
  );

  it("fails on a non-zero exit but still prints the receipt", () => {
    const result = runScript(["personal-stage", "migrator"], { exitCode: "17" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("migrator task failed with exit code 17");
    expect(receiptOf(result.stdout).exit_code).toBe(17);
  });

  it("fails when the container never reported an exit code", () => {
    const result = runScript(["personal-stage", "smoke"], { exitCode: "null" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("smoke task failed with exit code none");
  });

  it("fails closed when ECS rejects the task", () => {
    const result = runScript(["personal-stage", "migrator"], { runFailure: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ECS rejected the migrator task");
    expect(readFileSync(result.capturePath, "utf8")).not.toContain("ecs wait tasks-stopped");
  });

  it("fails closed when the task does not stop cleanly", () => {
    const result = runScript(["personal-stage", "smoke"], { waitFailure: true });

    expect(result.status).not.toBe(0);
    expect(readFileSync(result.capturePath, "utf8")).not.toContain("ecs describe-tasks");
    expect(result.stdout).not.toContain("Deploy task receipt");
  });

  it("fails closed before ECS when an SSM parameter is missing", () => {
    const result = runScript(["personal-stage", "migrator"], {
      missingParameter: "/comparative/personal-stage/10-network/sg/deploy_task_id",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "SSM parameters not found: /comparative/personal-stage/10-network/sg/deploy_task_id",
    );
    expect(readFileSync(result.capturePath, "utf8")).not.toContain("ecs run-task");
  });

  it("fails closed before ECS when the subnets are not a JSON list", () => {
    const result = runScript(["personal-stage", "migrator"], {
      subnets: "subnet-a,subnet-b",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a non-empty JSON list of subnet ids");
    expect(readFileSync(result.capturePath, "utf8")).not.toContain("ecs run-task");
  });

  it.each([
    [["personal-stage", "migrate"]],
    [["personal-stage"]],
    [["../personal-stage", "smoke"]],
  ])("rejects %j before calling AWS", (args) => {
    const result = runScript(args);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
    expect(readFileSync(result.capturePath, "utf8")).toBe("");
  });

  it("rejects a release id that is not a full commit sha before calling AWS", () => {
    const result = runScript(["personal-stage", "smoke"], { releaseId: "main" });

    expect(result.status).toBe(2);
    expect(readFileSync(result.capturePath, "utf8")).toBe("");
  });
});

function receiptOf(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").find((l) => l.startsWith("Deploy task receipt: "));
  expect(line, stdout).toBeDefined();
  return JSON.parse((line as string).slice("Deploy task receipt: ".length));
}

function runScript(
  args: string[],
  {
    runFailure = false,
    waitFailure = false,
    exitCode = "0",
    missingParameter = "",
    subnets = PARAMETERS["/comparative/personal-stage/10-network/app_subnet_ids"],
    releaseId = RELEASE_ID,
  }: {
    runFailure?: boolean;
    waitFailure?: boolean;
    exitCode?: string;
    missingParameter?: string;
    subnets?: string;
    releaseId?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "terraform-run-task-"));
  tempDirs.push(dir);
  const capturePath = join(dir, "commands.txt");
  writeFileSync(capturePath, "");
  const parameters = {
    ...PARAMETERS,
    "/comparative/personal-stage/10-network/app_subnet_ids": subnets,
  };
  writeFileSync(join(dir, "parameters.json"), JSON.stringify(parameters));
  const awsPath = join(dir, "aws");
  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\\n' "$*" >> "$FAKE_CAPTURE_PATH"

if [[ "$1 $2" == "ssm get-parameters" ]]; then
  shift 2
  names=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --names) shift; while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do names+=("$1"); shift; done ;;
      *) shift ;;
    esac
  done
  printf '%s\\n' "\${names[@]}" | jq -R . | jq -s --slurpfile p "$FAKE_PARAMETERS" --arg missing "$FAKE_MISSING" '
    {Parameters: [.[] | select(. != $missing and ($p[0][.] != null)) | {Name: ., Value: $p[0][.]}],
     InvalidParameters: [.[] | select(. == $missing or ($p[0][.] == null))]}'
elif [[ "$1 $2" == "ecs run-task" ]]; then
  if [[ "$FAKE_RUN_FAILURE" == "1" ]]; then
    printf '{"tasks":[],"failures":[{"reason":"ACCESS_DENIED"}]}\\n'
  else
    printf '{"tasks":[{"taskArn":"arn:task/deploy-123"}],"failures":[]}\\n'
  fi
elif [[ "$1 $2 $3" == "ecs wait tasks-stopped" ]]; then
  if [[ "$FAKE_WAIT_FAILURE" == "1" ]]; then
    echo "simulated waiter failure" >&2
    exit 255
  fi
elif [[ "$1 $2" == "ecs describe-tasks" ]]; then
  printf '{"tasks":[{"taskArn":"arn:task/deploy-123","taskDefinitionArn":"arn:task-definition/current:9","stoppedReason":"Essential container exited","containers":[{"name":"task","exitCode":%s}]}]}\\n' "$FAKE_EXIT_CODE"
else
  echo "unexpected aws command: $*" >&2
  exit 99
fi
`,
  );
  chmodSync(awsPath, 0o755);

  const result = spawnSync("bash", [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AWS_REGION: "us-east-1",
      RELEASE_ID: releaseId,
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_PARAMETERS: join(dir, "parameters.json"),
      FAKE_MISSING: missingParameter,
      FAKE_RUN_FAILURE: runFailure ? "1" : "0",
      FAKE_WAIT_FAILURE: waitFailure ? "1" : "0",
      FAKE_EXIT_CODE: exitCode,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
  };
}
