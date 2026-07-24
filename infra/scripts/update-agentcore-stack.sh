#!/usr/bin/env bash

set -euo pipefail

: "${AGENTCORE_STACK_NAME:?AGENTCORE_STACK_NAME is required}"
: "${AGENTCORE_IMAGE_TAG:?AGENTCORE_IMAGE_TAG is required}"
: "${AGENTCORE_DEPLOY_SEQUENCE:=${CODEBUILD_BUILD_NUMBER:-}}"
: "${AGENTCORE_DEPLOY_SEQUENCE:?AGENTCORE_DEPLOY_SEQUENCE or CODEBUILD_BUILD_NUMBER is required}"

AWS_DEPLOY_REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"
: "${AWS_DEPLOY_REGION:?AWS_DEFAULT_REGION or AWS_REGION is required}"
AGENTCORE_IMAGE_REPO_NAME="${AGENTCORE_IMAGE_REPO_NAME:-ai-workspace-agentcore-agent}"
MAX_TEMPLATE_BYTES=51200
MAX_UPDATE_ATTEMPTS=3
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SYNTH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentcore-cdk-synth.XXXXXX")"
trap 'rm -rf "$SYNTH_DIR"' EXIT

if [[ ! "$AGENTCORE_DEPLOY_SEQUENCE" =~ ^[0-9]+$ ]]; then
  echo "AgentCore deployment sequence must be a non-negative integer." >&2
  exit 1
fi

echo "Synthesizing current $AGENTCORE_STACK_NAME template..."
CDK_DEFAULT_REGION="$AWS_DEPLOY_REGION" \
  pnpm --dir "$REPO_ROOT" --filter @ai-workspace/infra exec cdk synth \
    "$AGENTCORE_STACK_NAME" \
    --exclusively \
    --quiet \
    --output "$SYNTH_DIR"

template_path="$SYNTH_DIR/$AGENTCORE_STACK_NAME.template.json"
if [[ ! -f "$template_path" ]]; then
  echo "CDK did not synthesize the expected template: $template_path" >&2
  exit 1
fi

template_bytes="$(wc -c < "$template_path" | tr -d ' ')"
if (( template_bytes > MAX_TEMPLATE_BYTES )); then
  echo "Synthesized AgentCore template is $template_bytes bytes; CloudFormation inline templates are limited to $MAX_TEMPLATE_BYTES bytes." >&2
  exit 1
fi

template_sha256="$(
  python3 - "$template_path" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"

image_lookup=""
if ! image_lookup="$(
  aws ecr describe-images \
    --region "$AWS_DEPLOY_REGION" \
    --repository-name "$AGENTCORE_IMAGE_REPO_NAME" \
    --image-ids "imageTag=$AGENTCORE_IMAGE_TAG" \
    --query 'imageDetails[0].imageDigest' \
    --output text 2>&1
)"; then
  echo "Could not resolve an immutable digest for AgentCore image tag $AGENTCORE_IMAGE_TAG: $image_lookup" >&2
  exit 1
fi
image_digest="$image_lookup"
if [[ ! "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "AgentCore image tag $AGENTCORE_IMAGE_TAG has no immutable ECR digest." >&2
  exit 1
fi

stack_json=""
stack_id=""
stack_status=""
deployed_tag=""
deployed_sequence=""
deployed_template_sha256=""

read_stack() {
  stack_json="$(
    aws cloudformation describe-stacks \
      --region "$AWS_DEPLOY_REGION" \
      --stack-name "$AGENTCORE_STACK_NAME" \
      --query 'Stacks[0]' \
      --output json
  )"
  stack_id="$(printf '%s' "$stack_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("StackId", ""))')"
  stack_status="$(printf '%s' "$stack_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("StackStatus", ""))')"
  deployed_tag="$(printf '%s' "$stack_json" | python3 -c '
import json, sys
stack = json.load(sys.stdin)
params = {item["ParameterKey"]: item.get("ParameterValue", "") for item in stack.get("Parameters", [])}
print(params.get("AgentImageTag", ""))
')"
  deployed_sequence="$(printf '%s' "$stack_json" | python3 -c '
import json, sys
stack = json.load(sys.stdin)
params = {item["ParameterKey"]: item.get("ParameterValue", "") for item in stack.get("Parameters", [])}
print(params.get("DeploymentSequence", "0"))
')"
  deployed_template_sha256="$(printf '%s' "$stack_json" | python3 -c '
import json, sys
stack = json.load(sys.stdin)
params = {item["ParameterKey"]: item.get("ParameterValue", "") for item in stack.get("Parameters", [])}
print(params.get("SourceTemplateSha256", ""))
')"
}

is_current_deployment() {
  [[ "$deployed_tag" == "$AGENTCORE_IMAGE_TAG" ]] &&
    [[ "$deployed_sequence" == "$AGENTCORE_DEPLOY_SEQUENCE" ]] &&
    [[ "$deployed_template_sha256" == "$template_sha256" ]]
}

is_success_status() {
  [[ "$stack_status" == "CREATE_COMPLETE" ]] ||
    [[ "$stack_status" == "UPDATE_COMPLETE" ]]
}

wait_for_concurrent_update() {
  echo "Another AgentCore stack update is in progress; waiting before retrying..."
  aws cloudformation wait stack-update-complete \
    --region "$AWS_DEPLOY_REGION" \
    --stack-name "$AGENTCORE_STACK_NAME"
}

updated=0
# DeploymentSequence is a receipt and defense-in-depth check, not an atomic
# lock. The parent ai-workspace-build project must keep concurrentBuildLimit=1.
for ((attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt += 1)); do
  read_stack

  if [[ ! "$deployed_sequence" =~ ^[0-9]+$ ]]; then
    echo "AgentCore stack reports invalid deployment sequence: $deployed_sequence" >&2
    exit 1
  fi
  if (( deployed_sequence > AGENTCORE_DEPLOY_SEQUENCE )); then
    echo "AgentCore deployment $AGENTCORE_DEPLOY_SEQUENCE was superseded by sequence $deployed_sequence." >&2
    exit 1
  fi
  if is_current_deployment && is_success_status; then
    echo "AgentCore stack already matches image tag $AGENTCORE_IMAGE_TAG and the current template."
    updated=1
    break
  fi
  if [[ "$stack_status" == *_IN_PROGRESS ]]; then
    wait_for_concurrent_update
    continue
  fi

  update_output=""
  if update_output="$(
    aws cloudformation update-stack \
      --region "$AWS_DEPLOY_REGION" \
      --stack-name "$AGENTCORE_STACK_NAME" \
      --template-body "file://$template_path" \
      --parameters \
        ParameterKey=CreateRuntime,UsePreviousValue=true \
        ParameterKey=AppSecretName,UsePreviousValue=true \
        ParameterKey=AgentImageTag,ParameterValue="$AGENTCORE_IMAGE_TAG" \
        ParameterKey=DeploymentSequence,ParameterValue="$AGENTCORE_DEPLOY_SEQUENCE" \
        ParameterKey=SourceTemplateSha256,ParameterValue="$template_sha256" \
      --capabilities CAPABILITY_NAMED_IAM \
      --client-request-token "agentcore-$AGENTCORE_DEPLOY_SEQUENCE-${AGENTCORE_IMAGE_TAG:0:12}" \
      --output json 2>&1
  )"; then
    echo "Waiting for AgentCore CloudFormation stack update..."
    aws cloudformation wait stack-update-complete \
      --region "$AWS_DEPLOY_REGION" \
      --stack-name "$AGENTCORE_STACK_NAME"
    updated=1
    break
  fi

  if [[ "$update_output" == *"No updates are to be performed"* ]]; then
    echo "CloudFormation reported no AgentCore changes; verifying the deployed receipt."
    updated=1
    break
  fi
  if [[ "$update_output" == *"_IN_PROGRESS"* ]]; then
    wait_for_concurrent_update
    continue
  fi

  echo "$update_output" >&2
  exit 1
done

if (( updated == 0 )); then
  echo "AgentCore stack remained busy after $MAX_UPDATE_ATTEMPTS attempts." >&2
  exit 1
fi

read_stack
if ! is_success_status; then
  echo "AgentCore stack reports status $stack_status after deployment." >&2
  exit 1
fi
if (( deployed_sequence > AGENTCORE_DEPLOY_SEQUENCE )); then
  echo "AgentCore deployment $AGENTCORE_DEPLOY_SEQUENCE completed after newer sequence $deployed_sequence took ownership." >&2
  exit 1
fi
if ! is_current_deployment; then
  echo "AgentCore deployment receipt does not match the requested image, sequence, and source template." >&2
  exit 1
fi

STACK_ID="$stack_id" \
STACK_STATUS="$stack_status" \
AGENTCORE_STACK_NAME="$AGENTCORE_STACK_NAME" \
AGENTCORE_IMAGE_TAG="$AGENTCORE_IMAGE_TAG" \
AGENTCORE_IMAGE_DIGEST="$image_digest" \
AGENTCORE_DEPLOY_SEQUENCE="$AGENTCORE_DEPLOY_SEQUENCE" \
SOURCE_TEMPLATE_SHA256="$template_sha256" \
python3 <<'PY'
import json
import os

receipt = {
    "commitSha": os.environ["AGENTCORE_IMAGE_TAG"],
    "imageDigest": os.environ["AGENTCORE_IMAGE_DIGEST"],
    "imageTag": os.environ["AGENTCORE_IMAGE_TAG"],
    "stack": os.environ["AGENTCORE_STACK_NAME"],
    "stackId": os.environ["STACK_ID"],
    "stackStatus": os.environ["STACK_STATUS"],
    "deploymentSequence": int(os.environ["AGENTCORE_DEPLOY_SEQUENCE"]),
    "sourceTemplateSha256": os.environ["SOURCE_TEMPLATE_SHA256"],
}
print("AgentCore deployment receipt: " + json.dumps(receipt, separators=(",", ":")))
PY
