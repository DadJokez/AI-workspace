import {
  chmodSync,
  existsSync,
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
  new URL(
    "../../../infra/scripts/configure-codebuild-source.sh",
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

describe("configure-codebuild-source.sh", () => {
  it("sets a full-history single-flight parent after verifying the ARM child", () => {
    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gitCloneDepth=0");
    expect(result.stdout).toContain("concurrentBuildLimit=1");
    expect(result.stdout).toContain(
      "agentCoreChild=ai-workspace-agentcore-build",
    );
    expect(JSON.parse(readFileSync(result.sourceCapturePath, "utf8"))).toEqual({
      type: "GITHUB",
      location: "https://github.com/DadJokez/AI-workspace.git",
      gitCloneDepth: 0,
      buildspec: "buildspec.yml",
      reportBuildStatus: true,
      insecureSsl: false,
    });
    expect(readFileSync(result.concurrencyCapturePath, "utf8").trim()).toBe(
      "1",
    );
    expect(JSON.parse(readFileSync(result.statePath, "utf8"))).toEqual({
      depth: 0,
      concurrentBuildLimit: 1,
    });
  });

  it("fails closed when CodeBuild rejects the update", () => {
    const result = runScript({ updateFailure: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated update failure");
    expect(JSON.parse(readFileSync(result.statePath, "utf8"))).toEqual({
      depth: 1,
      concurrentBuildLimit: 30,
    });
  });

  it("fails closed when the persisted checkout depth does not match", () => {
    const result = runScript({ depthVerificationMismatch: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checkout verification failed");
  });

  it("fails closed if CodeBuild stops returning the live-verified zero value", () => {
    const result = runScript({ omitVerificationDepth: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("got missing");
  });

  it("fails closed when the persisted concurrency limit does not match", () => {
    const result = runScript({ concurrencyVerificationMismatch: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("concurrency verification failed");
  });

  it("refuses to change the parent if the dedicated child is missing", () => {
    const result = runScript({ missingChild: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Expected CodeBuild projects ai-workspace-build and ai-workspace-agentcore-build",
    );
    expect(existsSync(result.sourceCapturePath)).toBe(false);
  });

  it("refuses to change the parent if the child is not a native ARM project", () => {
    const result = runScript({ invalidChild: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "AgentCore child project verification failed",
    );
    expect(result.stderr).toContain('"type":"LINUX_CONTAINER"');
    expect(existsSync(result.sourceCapturePath)).toBe(false);
  });

  it("documents the dedicated child, single-flight parent, fail-closed behavior, and IaC owner", () => {
    const deployment = readFileSync(
      join(ROOT, "docs/PRODUCTION_DEPLOYMENT.md"),
      "utf8",
    );

    expect(deployment).toContain("configure-codebuild-source.sh");
    expect(deployment).toContain("gitCloneDepth=0");
    expect(deployment).toContain("ai-workspace-agentcore-build");
    expect(deployment).toContain("concurrentBuildLimit=1");
    expect(deployment).toContain("fails closed");
    expect(deployment).toContain("#467");
  });
});

function runScript({
  concurrencyVerificationMismatch = false,
  depthVerificationMismatch = false,
  invalidChild = false,
  missingChild = false,
  updateFailure = false,
  omitVerificationDepth = false,
}: {
  concurrencyVerificationMismatch?: boolean;
  depthVerificationMismatch?: boolean;
  invalidChild?: boolean;
  missingChild?: boolean;
  updateFailure?: boolean;
  omitVerificationDepth?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codebuild-source-script-"));
  tempDirs.push(dir);
  const statePath = join(dir, "state.json");
  const sourceCapturePath = join(dir, "source.json");
  const concurrencyCapturePath = join(dir, "concurrency.txt");
  const awsPath = join(dir, "aws");
  writeFileSync(
    statePath,
    JSON.stringify({ depth: 1, concurrentBuildLimit: 30 }),
  );

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1 $2" == "codebuild batch-get-projects" ]]; then
  depth=$(jq -r '.depth' "$FAKE_STATE_PATH")
  concurrent_limit=$(jq -r '.concurrentBuildLimit' "$FAKE_STATE_PATH")
  include_child=0
  if [[ "$*" == *"ai-workspace-agentcore-build"* ]]; then
    include_child=1
  fi

  jq -n \
    --argjson depth "$depth" \
    --argjson concurrent_limit "$concurrent_limit" \
    --arg include_child "$include_child" \
    --arg invalid_child "$FAKE_INVALID_CHILD" \
    --arg missing_child "$FAKE_MISSING_CHILD" \
    --arg omit_depth "$FAKE_OMIT_VERIFICATION_DEPTH" \
    '{
      projects: (
        [
          {
            name: "ai-workspace-build",
            concurrentBuildLimit: $concurrent_limit,
            source: (
              {
                type: "GITHUB",
                location: "https://github.com/DadJokez/AI-workspace.git",
                buildspec: "buildspec.yml",
                reportBuildStatus: true,
                insecureSsl: false
              }
              + (
                if $omit_depth == "1" and $depth == 0
                then {}
                else { gitCloneDepth: $depth }
                end
              )
            )
          }
        ]
        + (
          if $include_child == "1" and $missing_child != "1"
          then [
            {
              name: "ai-workspace-agentcore-build",
              concurrentBuildLimit: 1,
              source: {
                type: "GITHUB",
                location: "https://github.com/DadJokez/AI-workspace.git",
                gitCloneDepth: 1,
                buildspec: "buildspec.agentcore.yml",
                reportBuildStatus: false,
                insecureSsl: false
              },
              environment: {
                type: (
                  if $invalid_child == "1"
                  then "LINUX_CONTAINER"
                  else "ARM_CONTAINER"
                  end
                ),
                image: "aws/codebuild/amazonlinux-aarch64-standard:3.0",
                computeType: "BUILD_GENERAL1_MEDIUM",
                privilegedMode: true
              },
              artifacts: { type: "NO_ARTIFACTS" }
            }
          ]
          else []
          end
        )
      ),
      projectsNotFound: (
        if $include_child == "1" and $missing_child == "1"
        then ["ai-workspace-agentcore-build"]
        else []
        end
      )
    }'
elif [[ "$1 $2" == "codebuild update-project" ]]; then
  if [[ "$FAKE_UPDATE_FAILURE" == "1" ]]; then
    echo "simulated update failure" >&2
    exit 1
  fi
  source_json=""
  concurrent_limit=""
  args=("$@")
  for ((i = 0; i < \${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "--source" ]]; then
      source_json="\${args[$((i + 1))]}"
    elif [[ "\${args[$i]}" == "--concurrent-build-limit" ]]; then
      concurrent_limit="\${args[$((i + 1))]}"
    fi
  done
  test -n "$source_json"
  test -n "$concurrent_limit"
  printf '%s\n' "$source_json" > "$FAKE_SOURCE_CAPTURE_PATH"
  printf '%s\n' "$concurrent_limit" > "$FAKE_CONCURRENCY_CAPTURE_PATH"
  old_depth=$(jq -r '.depth' "$FAKE_STATE_PATH")
  old_concurrent_limit=$(jq -r '.concurrentBuildLimit' "$FAKE_STATE_PATH")
  new_depth=$(jq -r '.gitCloneDepth' <<< "$source_json")
  if [[ "$FAKE_DEPTH_VERIFICATION_MISMATCH" == "1" ]]; then
    new_depth="$old_depth"
  fi
  if [[ "$FAKE_CONCURRENCY_VERIFICATION_MISMATCH" == "1" ]]; then
    concurrent_limit="$old_concurrent_limit"
  fi
  jq -n \
    --argjson depth "$new_depth" \
    --argjson concurrent_limit "$concurrent_limit" \
    '{ depth: $depth, concurrentBuildLimit: $concurrent_limit }' \
    > "$FAKE_STATE_PATH"
  echo '{"project":{"name":"ai-workspace-build"}}'
else
  echo "unexpected aws command: $*" >&2
  exit 2
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
      FAKE_CONCURRENCY_CAPTURE_PATH: concurrencyCapturePath,
      FAKE_CONCURRENCY_VERIFICATION_MISMATCH:
        concurrencyVerificationMismatch ? "1" : "0",
      FAKE_DEPTH_VERIFICATION_MISMATCH: depthVerificationMismatch ? "1" : "0",
      FAKE_INVALID_CHILD: invalidChild ? "1" : "0",
      FAKE_MISSING_CHILD: missingChild ? "1" : "0",
      FAKE_STATE_PATH: statePath,
      FAKE_SOURCE_CAPTURE_PATH: sourceCapturePath,
      FAKE_UPDATE_FAILURE: updateFailure ? "1" : "0",
      FAKE_OMIT_VERIFICATION_DEPTH: omitVerificationDepth ? "1" : "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    statePath,
    sourceCapturePath,
    concurrencyCapturePath,
  };
}
