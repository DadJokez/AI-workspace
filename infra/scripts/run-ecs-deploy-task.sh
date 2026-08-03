#!/usr/bin/env bash
set -euo pipefail

task_kind="${1:-}"
if [[ "$task_kind" != "migrate" && "$task_kind" != "smoke" ]]; then
  echo "Usage: $0 <migrate|smoke>" >&2
  exit 2
fi

: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
: "${COMMIT_TAG:?COMMIT_TAG is required}"

ECS_CLUSTER_NAME="${ECS_CLUSTER_NAME:-ai-workspace-prod}"
ECS_DEPLOY_TASK_STACK_NAME="${ECS_DEPLOY_TASK_STACK_NAME:-AiWorkspaceDeployTasksStack}"

outputs_json=$(aws cloudformation describe-stacks \
  --region "$AWS_DEFAULT_REGION" \
  --stack-name "$ECS_DEPLOY_TASK_STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output json)

resolved=$(DEPLOY_OUTPUTS_JSON="$outputs_json" TASK_KIND="$task_kind" python3 <<'PY'
import json
import os

outputs = {
    item.get("OutputKey"): item.get("OutputValue")
    for item in json.loads(os.environ["DEPLOY_OUTPUTS_JSON"])
    if isinstance(item, dict)
}
task_key = (
    "MigratorTaskDefinitionArn"
    if os.environ["TASK_KIND"] == "migrate"
    else "ProductionSmokeTaskDefinitionArn"
)
required = [task_key, "DeployTaskSecurityGroupId", "DeployTaskSubnetIds"]
missing = [key for key in required if not outputs.get(key)]
if missing:
    raise SystemExit("Missing deploy-task stack outputs: " + ", ".join(missing))
print(outputs[task_key])
print(outputs["DeployTaskSecurityGroupId"])
print(outputs["DeployTaskSubnetIds"])
PY
)

task_definition=$(printf '%s\n' "$resolved" | sed -n '1p')
security_group=$(printf '%s\n' "$resolved" | sed -n '2p')
subnet_csv=$(printf '%s\n' "$resolved" | sed -n '3p')
IFS=',' read -r -a subnets <<< "$subnet_csv"
subnet_list=$(IFS=,; printf '%s' "${subnets[*]}")
network_configuration="awsvpcConfiguration={subnets=[$subnet_list],securityGroups=[$security_group],assignPublicIp=ENABLED}"
started_by="deploy-${task_kind}-${COMMIT_TAG:0:12}"

run_json=$(aws ecs run-task \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --launch-type FARGATE \
  --task-definition "$task_definition" \
  --network-configuration "$network_configuration" \
  --started-by "$started_by" \
  --count 1 \
  --output json)

task_arn=$(RUN_TASK_JSON="$run_json" python3 <<'PY'
import json
import os

response = json.loads(os.environ["RUN_TASK_JSON"])
failures = response.get("failures") or []
if failures:
    raise SystemExit("ECS rejected the deploy task: " + json.dumps(failures))
tasks = response.get("tasks") or []
if len(tasks) != 1 or not tasks[0].get("taskArn"):
    raise SystemExit("ECS did not return exactly one deploy task ARN")
print(tasks[0]["taskArn"])
PY
)

echo "Waiting for $task_kind task $task_arn..."
aws ecs wait tasks-stopped \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --tasks "$task_arn"

task_json=$(aws ecs describe-tasks \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER_NAME" \
  --tasks "$task_arn" \
  --output json)

TASK_JSON="$task_json" TASK_KIND="$task_kind" COMMIT_TAG="$COMMIT_TAG" python3 <<'PY'
import json
import os

response = json.loads(os.environ["TASK_JSON"])
tasks = response.get("tasks") or []
if len(tasks) != 1:
    raise SystemExit("ECS task receipt is missing")
task = tasks[0]
containers = task.get("containers") or []
if len(containers) != 1:
    raise SystemExit("ECS task receipt must contain exactly one container")
container = containers[0]
exit_code = container.get("exitCode")
if exit_code != 0:
    reason = container.get("reason") or task.get("stoppedReason") or "unknown"
    raise SystemExit(
        f"{os.environ['TASK_KIND']} task failed with exit code {exit_code}: {reason}"
    )
receipt = {
    "kind": os.environ["TASK_KIND"],
    "commitSha": os.environ["COMMIT_TAG"],
    "taskArn": task.get("taskArn"),
    "taskDefinitionArn": task.get("taskDefinitionArn"),
    "exitCode": exit_code,
}
print("Deploy task receipt: " + json.dumps(receipt, separators=(",", ":")))
PY
