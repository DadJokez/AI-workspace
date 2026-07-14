#!/usr/bin/env bash
set -euo pipefail

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
: "${COMMIT_TAG:?COMMIT_TAG is required}"

ECS_STACK_NAME="${ECS_STACK_NAME:-AiWorkspaceEcsStack}"
ECS_CLUSTER_NAME="${ECS_CLUSTER_NAME:-ai-workspace-prod}"
ECS_WEB_SERVICE_NAME="${ECS_WEB_SERVICE_NAME:-ai-workspace-web}"
ECS_CHAT_WORKER_SERVICE_NAME="${ECS_CHAT_WORKER_SERVICE_NAME:-ai-workspace-chat-worker}"
ECS_MEMORY_WORKER_SERVICE_NAME="${ECS_MEMORY_WORKER_SERVICE_NAME:-ai-workspace-memory-worker}"
SERVICES=(
  "$ECS_WEB_SERVICE_NAME"
  "$ECS_CHAT_WORKER_SERVICE_NAME"
  "$ECS_MEMORY_WORKER_SERVICE_NAME"
)

echo "Reconciling $ECS_STACK_NAME before refreshing ECS images..."
CDK_DEFAULT_REGION="$AWS_DEFAULT_REGION" \
  pnpm --filter @ai-workspace/infra exec cdk deploy "$ECS_STACK_NAME" \
  --require-approval never \
  --exclusively

echo "Forcing ECS service deployments for commit $COMMIT_TAG..."
for service in "${SERVICES[@]}"; do
  aws ecs update-service \
    --region "$AWS_DEFAULT_REGION" \
    --cluster "$ECS_CLUSTER_NAME" \
    --service "$service" \
    --force-new-deployment >/dev/null
done

echo "Waiting for ECS services to stabilize..."
aws ecs wait services-stable \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --services "${SERVICES[@]}"

services_json=$(aws ecs describe-services \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --services "${SERVICES[@]}" \
  --query 'services[].{service:serviceName,taskDefinition:taskDefinition}' \
  --output json)

DEPLOYED_SERVICES_JSON="$services_json" \
EXPECTED_SERVICES="${SERVICES[*]}" \
ECS_STACK_NAME="$ECS_STACK_NAME" \
ECS_CLUSTER_NAME="$ECS_CLUSTER_NAME" \
COMMIT_TAG="$COMMIT_TAG" \
python3 <<'PY'
import json
import os

services = json.loads(os.environ["DEPLOYED_SERVICES_JSON"])
expected = set(os.environ["EXPECTED_SERVICES"].split())
found = {
    item.get("service")
    for item in services
    if isinstance(item, dict) and item.get("taskDefinition")
}
missing = sorted(expected - found)
if missing:
    raise SystemExit(
        "Deployment receipt is missing stable task definitions for: "
        + ", ".join(missing)
    )

receipt = {
    "commitSha": os.environ["COMMIT_TAG"],
    "stack": os.environ["ECS_STACK_NAME"],
    "cluster": os.environ["ECS_CLUSTER_NAME"],
    "services": services,
}
print("Deployment receipt: " + json.dumps(receipt, separators=(",", ":")))
PY
