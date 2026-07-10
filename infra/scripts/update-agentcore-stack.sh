#!/usr/bin/env bash

set -euo pipefail

: "${AGENTCORE_STACK_NAME:?AGENTCORE_STACK_NAME is required}"
: "${AGENTCORE_IMAGE_TAG:?AGENTCORE_IMAGE_TAG is required}"

AWS_DEPLOY_REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"
: "${AWS_DEPLOY_REGION:?AWS_DEFAULT_REGION or AWS_REGION is required}"

update_output=""
if update_output="$(
  aws cloudformation update-stack \
    --region "$AWS_DEPLOY_REGION" \
    --stack-name "$AGENTCORE_STACK_NAME" \
    --use-previous-template \
    --parameters \
      ParameterKey=CreateRuntime,UsePreviousValue=true \
      ParameterKey=AgentImageTag,ParameterValue="$AGENTCORE_IMAGE_TAG" \
    --capabilities CAPABILITY_NAMED_IAM \
    --output json 2>&1
)"; then
  echo "Waiting for AgentCore CloudFormation stack update..."
  aws cloudformation wait stack-update-complete \
    --region "$AWS_DEPLOY_REGION" \
    --stack-name "$AGENTCORE_STACK_NAME"
elif [[ "$update_output" != *"No updates are to be performed"* ]]; then
  echo "$update_output" >&2
  exit 1
else
  echo "AgentCore stack already targets image tag $AGENTCORE_IMAGE_TAG."
fi

deployed_tag="$(
  aws cloudformation describe-stacks \
    --region "$AWS_DEPLOY_REGION" \
    --stack-name "$AGENTCORE_STACK_NAME" \
    --query "Stacks[0].Parameters[?ParameterKey=='AgentImageTag'].ParameterValue | [0]" \
    --output text
)"

if [[ "$deployed_tag" != "$AGENTCORE_IMAGE_TAG" ]]; then
  echo "AgentCore stack reports image tag $deployed_tag, expected $AGENTCORE_IMAGE_TAG." >&2
  exit 1
fi

echo "AgentCore stack $AGENTCORE_STACK_NAME now targets image tag $AGENTCORE_IMAGE_TAG."
