import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../infra/scripts/update-agentcore-runtime.sh", import.meta.url),
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("update-agentcore-runtime.sh", () => {
  it("preserves present runtime configuration and omits null or response-only fields", () => {
    const config = {
      agentRuntimeId: "runtime-1",
      agentRuntimeVersion: "2",
      status: "READY",
      roleArn: "arn:aws:iam::123456789012:role/runtime-role",
      networkConfiguration: { networkMode: "PUBLIC" },
      description: "Comparative durable worker",
      protocolConfiguration: { serverProtocol: "HTTP" },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 900,
        maxLifetime: 28_800,
      },
      metadataConfiguration: { requireMMDSV2: true },
      environmentVariables: { BEDROCK_CLIENT: "sensitive-test-value" },
      authorizerConfiguration: null,
      requestHeaderConfiguration: null,
      filesystemConfigurations: null,
      workloadIdentityDetails: { workloadIdentityArn: "response-only" },
    };

    const result = runScript(config);
    expect(result.status).toBe(0);

    const payload = JSON.parse(readFileSync(result.capturePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      agentRuntimeId: "runtime-1",
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:sha",
        },
      },
      roleArn: config.roleArn,
      networkConfiguration: config.networkConfiguration,
      description: config.description,
      protocolConfiguration: config.protocolConfiguration,
      lifecycleConfiguration: config.lifecycleConfiguration,
      metadataConfiguration: config.metadataConfiguration,
      environmentVariables: config.environmentVariables,
    });
    expect(payload).not.toHaveProperty("authorizerConfiguration");
    expect(payload).not.toHaveProperty("requestHeaderConfiguration");
    expect(payload).not.toHaveProperty("filesystemConfigurations");
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("workloadIdentityDetails");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "sensitive-test-value",
    );
  });

  it("refuses to update when required runtime configuration is missing", () => {
    const result = runScript({
      agentRuntimeId: "runtime-1",
      networkConfiguration: { networkMode: "PUBLIC" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing a roleArn");
    expect(existsSync(result.capturePath)).toBe(false);
  });
});

function runScript(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-deploy-script-"));
  tempDirs.push(dir);
  const awsPath = join(dir, "aws");
  const capturePath = join(dir, "captured-payload.json");
  const statePath = join(dir, "updated");

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1 $2" == "bedrock-agentcore-control get-agent-runtime" ]]; then
  if [[ -f "$FAKE_STATE_PATH" ]]; then
    printf '%s' "$FAKE_AGENTCORE_CONFIG" | jq '.agentRuntimeVersion = "3" | .status = "READY"'
  else
    printf '%s' "$FAKE_AGENTCORE_CONFIG"
  fi
  exit 0
fi

if [[ "$1 $2" == "bedrock-agentcore-control update-agent-runtime" ]]; then
  while (( "$#" )); do
    if [[ "$1" == "--cli-input-json" ]]; then
      shift
      cp "\${1#file://}" "$FAKE_CAPTURE_PATH"
      touch "$FAKE_STATE_PATH"
      printf '{"agentRuntimeVersion":"3","status":"UPDATING"}'
      exit 0
    fi
    shift
  done
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
      AGENTCORE_RUNTIME_ID: "runtime-1",
      AGENTCORE_IMAGE_URI:
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:sha",
      AGENTCORE_UPDATE_POLL_SECONDS: "0",
      AWS_DEFAULT_REGION: "us-east-1",
      FAKE_AGENTCORE_CONFIG: JSON.stringify(config),
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_STATE_PATH: statePath,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
  };
}
