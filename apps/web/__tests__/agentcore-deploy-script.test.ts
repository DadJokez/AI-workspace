import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../infra/scripts/update-agentcore-stack.sh", import.meta.url),
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("update-agentcore-stack.sh", () => {
  it("updates the CloudFormation image tag and waits for completion", () => {
    const result = runScript();
    expect(result.status).toBe(0);
    expect(readFileSync(result.capturePath, "utf8")).toContain(
      "ParameterKey=AgentImageTag,ParameterValue=sha",
    );
    expect(readFileSync(result.waitPath, "utf8")).toContain(
      "stack-update-complete",
    );
  });

  it("accepts an idempotent no-op when the stack already has the tag", () => {
    const result = runScript({ noUpdates: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already targets image tag sha");
  });
});

function runScript({ noUpdates = false }: { noUpdates?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-deploy-script-"));
  tempDirs.push(dir);
  const awsPath = join(dir, "aws");
  const capturePath = join(dir, "update-command.txt");
  const waitPath = join(dir, "wait-command.txt");

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1 $2" == "cloudformation update-stack" ]]; then
  printf '%s\n' "$*" > "$FAKE_CAPTURE_PATH"
  if [[ "$FAKE_NO_UPDATES" == "1" ]]; then
    echo "An error occurred (ValidationError): No updates are to be performed." >&2
    exit 255
  fi
  printf '{"StackId":"stack-id"}'
  exit 0
fi

if [[ "$1 $2" == "cloudformation wait" ]]; then
  printf '%s\n' "$*" > "$FAKE_WAIT_PATH"
  exit 0
fi

if [[ "$1 $2" == "cloudformation describe-stacks" ]]; then
  printf '%s' "$AGENTCORE_IMAGE_TAG"
  exit 0
fi

echo "unexpected fake aws command" >&2
exit 1
`,
  );
  chmodSync(awsPath, 0o755);

  const result = spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AGENTCORE_STACK_NAME: "AiWorkspaceAgentCoreSpikeStack",
      AGENTCORE_IMAGE_TAG: "sha",
      AWS_DEFAULT_REGION: "us-east-1",
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_WAIT_PATH: waitPath,
      FAKE_NO_UPDATES: noUpdates ? "1" : "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
    waitPath,
  };
}
