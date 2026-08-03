#!/usr/bin/env bash
set -euo pipefail

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
: "${COMMIT_TAG:?COMMIT_TAG is required}"

ECS_DEPLOY_TASK_STACK_NAME="${ECS_DEPLOY_TASK_STACK_NAME:-AiWorkspaceDeployTasksStack}"

echo "Reconciling $ECS_DEPLOY_TASK_STACK_NAME with commit $COMMIT_TAG images..."
CDK_DEFAULT_REGION="$AWS_DEFAULT_REGION" \
  pnpm --filter @ai-workspace/infra exec cdk deploy "$ECS_DEPLOY_TASK_STACK_NAME" \
  --require-approval never \
  --parameters "ImageTag=$COMMIT_TAG" \
  --exclusively
