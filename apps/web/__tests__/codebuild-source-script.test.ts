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
  it("sets a full-history checkout while preserving every other source setting", () => {
    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("gitCloneDepth=0");
    expect(JSON.parse(readFileSync(result.sourceCapturePath, "utf8"))).toEqual({
      type: "GITHUB",
      location: "https://github.com/DadJokez/AI-workspace.git",
      gitCloneDepth: 0,
      buildspec: "buildspec.yml",
      reportBuildStatus: true,
      insecureSsl: false,
    });
    expect(readFileSync(result.statePath, "utf8").trim()).toBe("0");
  });

  it("fails closed when CodeBuild rejects the update", () => {
    const result = runScript({ updateFailure: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated update failure");
    expect(readFileSync(result.statePath, "utf8").trim()).toBe("1");
  });

  it("fails closed when the persisted checkout depth does not match", () => {
    const result = runScript({ verificationMismatch: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checkout verification failed");
  });

  it("fails closed if CodeBuild stops returning the live-verified zero value", () => {
    const result = runScript({ omitVerificationDepth: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("got missing");
  });

  it("documents the reconciler, full history, fail-closed behavior, and IaC owner", () => {
    const deployment = readFileSync(
      join(ROOT, "docs/PRODUCTION_DEPLOYMENT.md"),
      "utf8",
    );

    expect(deployment).toContain("configure-codebuild-source.sh");
    expect(deployment).toContain("gitCloneDepth=0");
    expect(deployment).toContain("fails closed");
    expect(deployment).toContain("#467");
  });
});

function runScript({
  updateFailure = false,
  verificationMismatch = false,
  omitVerificationDepth = false,
}: {
  updateFailure?: boolean;
  verificationMismatch?: boolean;
  omitVerificationDepth?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codebuild-source-script-"));
  tempDirs.push(dir);
  const statePath = join(dir, "depth.txt");
  const sourceCapturePath = join(dir, "source.json");
  const awsPath = join(dir, "aws");
  writeFileSync(statePath, "1\n");

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1 $2" == "codebuild batch-get-projects" ]]; then
  depth=$(cat "$FAKE_STATE_PATH")
  if [[ "$FAKE_OMIT_VERIFICATION_DEPTH" == "1" && "$depth" == "0" ]]; then
    jq -n '{
      projects: [{
        name: "ai-workspace-build",
        source: {
          type: "GITHUB",
          location: "https://github.com/DadJokez/AI-workspace.git",
          buildspec: "buildspec.yml",
          reportBuildStatus: true,
          insecureSsl: false
        }
      }],
      projectsNotFound: []
    }'
  else
    jq -n --argjson depth "$depth" '{
      projects: [{
        name: "ai-workspace-build",
        source: {
          type: "GITHUB",
          location: "https://github.com/DadJokez/AI-workspace.git",
          gitCloneDepth: $depth,
          buildspec: "buildspec.yml",
          reportBuildStatus: true,
          insecureSsl: false
        }
      }],
      projectsNotFound: []
    }'
  fi
elif [[ "$1 $2" == "codebuild update-project" ]]; then
  if [[ "$FAKE_UPDATE_FAILURE" == "1" ]]; then
    echo "simulated update failure" >&2
    exit 1
  fi
  source_json=""
  args=("$@")
  for ((i = 0; i < \${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "--source" ]]; then
      source_json="\${args[$((i + 1))]}"
      break
    fi
  done
  printf '%s\n' "$source_json" > "$FAKE_SOURCE_CAPTURE_PATH"
  if [[ "$FAKE_VERIFICATION_MISMATCH" != "1" ]]; then
    jq -r '.gitCloneDepth' <<< "$source_json" > "$FAKE_STATE_PATH"
  fi
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
      FAKE_STATE_PATH: statePath,
      FAKE_SOURCE_CAPTURE_PATH: sourceCapturePath,
      FAKE_UPDATE_FAILURE: updateFailure ? "1" : "0",
      FAKE_VERIFICATION_MISMATCH: verificationMismatch ? "1" : "0",
      FAKE_OMIT_VERIFICATION_DEPTH: omitVerificationDepth ? "1" : "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    statePath,
    sourceCapturePath,
  };
}
