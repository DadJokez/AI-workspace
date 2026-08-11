#!/usr/bin/env bash
# #449: one-command production rollback to a previously built commit.
#
#   AWS_DEFAULT_REGION=us-east-1 ./infra/scripts/rollback-ecs.sh <commit-sha>
#
# Redeploys AiWorkspaceEcsStack with ImageTag=<commit-sha>, so the web and
# workers roll to the images that commit's build pushed. The Browser proxy
# stays on its current compatible image because pre-Browser commits do not
# contain the proxy entrypoint. This does NOT roll back database migrations — check
# drizzle/ for migrations landed since the target commit before rolling back
# across one (expand/contract rule: see docs/PRODUCTION_DEPLOYMENT.md).
set -euo pipefail

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
TARGET_TAG="${1:?usage: rollback-ecs.sh <commit-sha>}"

IMAGE_REPO_NAME="${IMAGE_REPO_NAME:-ai-workspace}"
ECS_STACK_NAME="${ECS_STACK_NAME:-AiWorkspaceEcsStack}"
ECS_CLUSTER_NAME="${ECS_CLUSTER_NAME:-ai-workspace-prod}"
SERVICES=(
  "${ECS_WEB_SERVICE_NAME:-ai-workspace-web}"
  "${ECS_CHAT_WORKER_SERVICE_NAME:-ai-workspace-chat-worker}"
  "${ECS_MEMORY_WORKER_SERVICE_NAME:-ai-workspace-memory-worker}"
  "${ECS_BROWSER_PROXY_SERVICE_NAME:-ai-workspace-browser-proxy}"
)

echo "Validating images for $TARGET_TAG exist in ECR..."
for tag in "$TARGET_TAG" "worker-$TARGET_TAG" "memory-worker-$TARGET_TAG"; do
  aws ecr describe-images \
    --region "$AWS_DEFAULT_REGION" \
    --repository-name "$IMAGE_REPO_NAME" \
    --image-ids imageTag="$tag" >/dev/null \
    || { echo "ERROR: $IMAGE_REPO_NAME:$tag not found in ECR — cannot roll back to a commit that was never built."; exit 1; }
done

browser_proxy_image_tag=$(aws cloudformation describe-stacks \
  --region "$AWS_DEFAULT_REGION" \
  --stack-name "$ECS_STACK_NAME" \
  --query "Stacks[0].Parameters[?ParameterKey=='BrowserProxyImageTag'].ParameterValue | [0]" \
  --output text)
if [[ -z "$browser_proxy_image_tag" || "$browser_proxy_image_tag" == "None" ]]; then
  browser_proxy_image_tag="worker-latest"
fi
aws ecr describe-images \
  --region "$AWS_DEFAULT_REGION" \
  --repository-name "$IMAGE_REPO_NAME" \
  --image-ids imageTag="$browser_proxy_image_tag" >/dev/null \
  || { echo "ERROR: $IMAGE_REPO_NAME:$browser_proxy_image_tag not found in ECR — cannot preserve the Browser proxy during rollback."; exit 1; }

echo "Rolling $ECS_STACK_NAME back to ImageTag=$TARGET_TAG..."
CDK_DEFAULT_REGION="$AWS_DEFAULT_REGION" \
  pnpm --filter @ai-workspace/infra exec cdk deploy "$ECS_STACK_NAME" \
  --require-approval never \
  --parameters "ImageTag=$TARGET_TAG" \
  --parameters "BrowserProxyImageTag=$browser_proxy_image_tag" \
  --exclusively

echo "Waiting for ECS services to stabilize on $TARGET_TAG..."
aws ecs wait services-stable \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --services "${SERVICES[@]}"

echo "Rollback to $TARGET_TAG complete."
