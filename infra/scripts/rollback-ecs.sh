#!/usr/bin/env bash
# #449: one-command production rollback to a previously built commit.
#
#   AWS_DEFAULT_REGION=us-east-1 ./infra/scripts/rollback-ecs.sh <commit-sha>
#
# Redeploys AiWorkspaceEcsStack with ImageTag=<commit-sha>, so all three ECS
# services (web, chat-worker, memory-worker) roll to the images that commit's
# build pushed. Validates the images exist in ECR first, and waits for the
# services to stabilize. This does NOT roll back database migrations — check
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
)

echo "Validating images for $TARGET_TAG exist in ECR..."
for tag in "$TARGET_TAG" "worker-$TARGET_TAG" "memory-worker-$TARGET_TAG"; do
  aws ecr describe-images \
    --region "$AWS_DEFAULT_REGION" \
    --repository-name "$IMAGE_REPO_NAME" \
    --image-ids imageTag="$tag" >/dev/null \
    || { echo "ERROR: $IMAGE_REPO_NAME:$tag not found in ECR — cannot roll back to a commit that was never built."; exit 1; }
done

echo "Rolling $ECS_STACK_NAME back to ImageTag=$TARGET_TAG..."
CDK_DEFAULT_REGION="$AWS_DEFAULT_REGION" \
  pnpm --filter @ai-workspace/infra exec cdk deploy "$ECS_STACK_NAME" \
  --require-approval never \
  --parameters "ImageTag=$TARGET_TAG" \
  --exclusively

echo "Waiting for ECS services to stabilize on $TARGET_TAG..."
aws ecs wait services-stable \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --services "${SERVICES[@]}"

echo "Rollback to $TARGET_TAG complete."
