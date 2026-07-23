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
  new URL("../../../infra/scripts/update-agentcore-stack.sh", import.meta.url),
);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("update-agentcore-stack.sh", () => {
  it("reconciles the current template and immutable image in one stack update", () => {
    const result = runScript();

    expect(result.status).toBe(0);
    const commands = readFileSync(result.capturePath, "utf8");
    expect(commands).toContain(
      "cloudformation update-stack --region us-east-1 --stack-name AiWorkspaceAgentCoreSpikeStack",
    );
    expect(commands).toContain("--template-body file://");
    expect(commands).not.toContain("--use-previous-template");
    expect(commands).toContain(
      "ParameterKey=AgentImageTag,ParameterValue=commit-sha",
    );
    expect(commands).toContain(
      "ParameterKey=DeploymentSequence,ParameterValue=42",
    );
    expect(commands).toContain(
      "ParameterKey=SourceTemplateSha256,ParameterValue=",
    );
    expect(readFileSync(result.templateCapturePath, "utf8")).toContain(
      "bedrock-agentcore:InvokeAgentRuntimeForUser",
    );
    expect(commands).toContain("cloudformation wait stack-update-complete");
    expect(result.stdout).toContain("AgentCore deployment receipt:");
    expect(result.stdout).toContain('"commitSha":"commit-sha"');
    expect(result.stdout).toContain(
      '"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    );
    expect(result.stdout).toContain('"deploymentSequence":42');
    expect(result.stdout).toContain('"sourceTemplateSha256":"');
  });

  it("accepts an idempotent deployment only when the full receipt matches", () => {
    const result = runScript({ alreadyCurrent: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "already matches image tag commit-sha and the current template",
    );
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "cloudformation update-stack",
    );
  });

  it("fails closed before updating when a newer build owns the stack", () => {
    const result = runScript({ superseded: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "deployment 42 was superseded by sequence 43",
    );
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "cloudformation update-stack",
    );
  });

  it("fails closed when CloudFormation rejects the current template", () => {
    const result = runScript({ updateFailure: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("simulated stack failure");
    expect(result.stdout).not.toContain("AgentCore deployment receipt:");
  });

  it("fails closed when the deployed template receipt does not match", () => {
    const result = runScript({ receiptMismatch: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "receipt does not match the requested image, sequence, and source template",
    );
  });

  it("fails before CloudFormation when the immutable image is missing", () => {
    const result = runScript({ missingImage: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no immutable ECR digest");
    expect(readFileSync(result.capturePath, "utf8")).not.toContain(
      "cloudformation update-stack",
    );
  });

  it("runs after the native image succeeds and before ECS and smoke", () => {
    const buildspec = readFileSync(join(ROOT, "buildspec.yml"), "utf8");
    const agentCoreDeploy = buildspec.indexOf("update-agentcore-stack.sh");

    expect(agentCoreDeploy).toBeGreaterThan(
      buildspec.indexOf('agentcore-image-build.sh wait "$AGENTCORE_BUILD_ID"'),
    );
    expect(agentCoreDeploy).toBeGreaterThan(
      buildspec.indexOf("docker push $REPOSITORY_URI:memory-worker-$COMMIT_TAG"),
    );
    expect(agentCoreDeploy).toBeLessThan(
      buildspec.indexOf("deploy-ecs-stack.sh"),
    );
    expect(agentCoreDeploy).toBeLessThan(
      buildspec.indexOf("Running authenticated production smoke"),
    );
    expect(buildspec).toContain(
      'AGENTCORE_DEPLOY_SEQUENCE="$CODEBUILD_BUILD_NUMBER"',
    );
  });
});

function runScript({
  alreadyCurrent = false,
  missingImage = false,
  receiptMismatch = false,
  superseded = false,
  updateFailure = false,
}: {
  alreadyCurrent?: boolean;
  missingImage?: boolean;
  receiptMismatch?: boolean;
  superseded?: boolean;
  updateFailure?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentcore-deploy-script-"));
  tempDirs.push(dir);
  const awsPath = join(dir, "aws");
  const pnpmPath = join(dir, "pnpm");
  const capturePath = join(dir, "commands.txt");
  const statePath = join(dir, "stack-state.txt");
  const synthHashPath = join(dir, "synth-hash.txt");
  const templateCapturePath = join(dir, "submitted-template.json");

  writeFileSync(
    pnpmPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\n' "$*" >> "$FAKE_CAPTURE_PATH"

output_dir=""
args=("$@")
for ((index = 0; index < \${#args[@]}; index += 1)); do
  if [[ "\${args[$index]}" == "--output" ]]; then
    output_dir="\${args[$((index + 1))]}"
  fi
done
test -n "$output_dir"
mkdir -p "$output_dir"
cat > "$output_dir/AiWorkspaceAgentCoreSpikeStack.template.json" <<'JSON'
{
  "Resources": {
    "CurrentIamPolicy": {
      "Type": "AWS::IAM::ManagedPolicy",
      "Properties": {
        "PolicyDocument": {
          "Statement": [
            {"Action": ["bedrock-agentcore:InvokeAgentRuntimeForUser"]}
          ]
        }
      }
    }
  }
}
JSON
python3 - "$output_dir/AiWorkspaceAgentCoreSpikeStack.template.json" > "$FAKE_SYNTH_HASH_PATH" <<'PY'
import hashlib
import pathlib
import sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
`,
  );
  chmodSync(pnpmPath, 0o755);

  writeFileSync(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'aws %s\n' "$*" >> "$FAKE_CAPTURE_PATH"

if [[ "$1 $2" == "ecr describe-images" ]]; then
  if [[ "$FAKE_MISSING_IMAGE" == "1" ]]; then
    printf 'None'
  else
    printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  fi
  exit 0
fi

if [[ "$1 $2" == "cloudformation describe-stacks" ]]; then
  synth_hash="$(cat "$FAKE_SYNTH_HASH_PATH")"
  tag="old-tag"
  sequence="41"
  template_hash="old-template"

  if [[ "$FAKE_ALREADY_CURRENT" == "1" ]]; then
    tag="commit-sha"
    sequence="42"
    template_hash="$synth_hash"
  elif [[ "$FAKE_SUPERSEDED" == "1" ]]; then
    tag="newer-sha"
    sequence="43"
    template_hash="newer-template"
  elif [[ -f "$FAKE_STATE_PATH" ]]; then
    IFS='|' read -r tag sequence template_hash < "$FAKE_STATE_PATH"
  fi

  cat <<JSON
{
  "StackId": "arn:aws:cloudformation:us-east-1:123:stack/AiWorkspaceAgentCoreSpikeStack/id",
  "StackStatus": "UPDATE_COMPLETE",
  "Parameters": [
    {"ParameterKey": "AgentImageTag", "ParameterValue": "$tag"},
    {"ParameterKey": "DeploymentSequence", "ParameterValue": "$sequence"},
    {"ParameterKey": "SourceTemplateSha256", "ParameterValue": "$template_hash"}
  ]
}
JSON
  exit 0
fi

if [[ "$1 $2" == "cloudformation update-stack" ]]; then
  if [[ "$FAKE_UPDATE_FAILURE" == "1" ]]; then
    echo "simulated stack failure" >&2
    exit 255
  fi

  tag=""
  sequence=""
  template_hash=""
  template_uri=""
  for arg in "$@"; do
    case "$arg" in
      ParameterKey=AgentImageTag,ParameterValue=*)
        tag="\${arg#*=AgentImageTag,ParameterValue=}"
        ;;
      ParameterKey=DeploymentSequence,ParameterValue=*)
        sequence="\${arg#*=DeploymentSequence,ParameterValue=}"
        ;;
      ParameterKey=SourceTemplateSha256,ParameterValue=*)
        template_hash="\${arg#*=SourceTemplateSha256,ParameterValue=}"
        ;;
      file://*)
        template_uri="$arg"
        ;;
    esac
  done
  cp "\${template_uri#file://}" "$FAKE_TEMPLATE_CAPTURE_PATH"
  if [[ "$FAKE_RECEIPT_MISMATCH" == "1" ]]; then
    template_hash="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  fi
  printf '%s|%s|%s\n' "$tag" "$sequence" "$template_hash" > "$FAKE_STATE_PATH"
  printf '{"StackId":"stack-id"}'
  exit 0
fi

if [[ "$1 $2" == "cloudformation wait" ]]; then
  exit 0
fi

echo "unexpected fake aws command: $*" >&2
exit 1
`,
  );
  chmodSync(awsPath, 0o755);
  writeFileSync(capturePath, "");

  const result = spawnSync("bash", [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      AGENTCORE_STACK_NAME: "AiWorkspaceAgentCoreSpikeStack",
      AGENTCORE_IMAGE_REPO_NAME: "ai-workspace-agentcore-agent",
      AGENTCORE_IMAGE_TAG: "commit-sha",
      AGENTCORE_DEPLOY_SEQUENCE: "42",
      AWS_DEFAULT_REGION: "us-east-1",
      FAKE_ALREADY_CURRENT: alreadyCurrent ? "1" : "0",
      FAKE_CAPTURE_PATH: capturePath,
      FAKE_MISSING_IMAGE: missingImage ? "1" : "0",
      FAKE_RECEIPT_MISMATCH: receiptMismatch ? "1" : "0",
      FAKE_STATE_PATH: statePath,
      FAKE_SUPERSEDED: superseded ? "1" : "0",
      FAKE_SYNTH_HASH_PATH: synthHashPath,
      FAKE_TEMPLATE_CAPTURE_PATH: templateCapturePath,
      FAKE_UPDATE_FAILURE: updateFailure ? "1" : "0",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    capturePath,
    templateCapturePath,
  };
}
