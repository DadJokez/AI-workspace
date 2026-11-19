#!/usr/bin/env bash
# run-task.sh <env> <migrator|smoke> — runs one deploy task of 35-deploy-tasks
# to completion and fails unless its container exits 0.
#
# Everything it needs comes from the SSM parameters the stacks publish, under
# /comparative/<env>/: the cluster (30-platform), the app subnets and the
# deploy_task security group (10-network), and the task definition
# (35-deploy-tasks, revision included). The task runs on Fargate in the
# private app subnets, without a public IP.
#
# Environment: AWS_REGION, RELEASE_ID (the full commit sha of the release; the
# task is started by deploy-<task>-<first 12>).
#
# stdout: `Deploy task receipt: {"task", "release_id", "task_arn",
#         "task_definition_arn", "exit_code"}` once the task has stopped,
#         whatever its exit code.
# exit:   0 when the container exited 0; 1 on any failure; 2 on a usage error.
set -euo pipefail

usage() {
  echo "usage: run-task.sh <env> <migrator|smoke>" >&2
  exit 2
}
[ "$#" -eq 2 ] || usage
env_name=$1
task=$2
[[ "$env_name" =~ ^[a-z0-9-]+$ ]] || usage
case "$task" in migrator | smoke) ;; *) usage ;; esac

: "${AWS_REGION:?AWS_REGION is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
[[ "$RELEASE_ID" =~ ^[0-9a-f]{40}$ ]] || { echo "run-task.sh: RELEASE_ID is not a full commit sha" >&2; exit 2; }

fail() {
  echo "run-task.sh: $*" >&2
  exit 1
}

prefix="/comparative/$env_name"
cluster_name="$prefix/30-platform/cluster_arn"
subnets_name="$prefix/10-network/app_subnet_ids"
security_group_name="$prefix/10-network/sg/deploy_task_id"
task_definition_name="$prefix/35-deploy-tasks/taskdef/${task}_arn"

parameters=$(aws ssm get-parameters --region "$AWS_REGION" --output json \
  --names "$cluster_name" "$subnets_name" "$security_group_name" "$task_definition_name")

missing=$(jq -r '.InvalidParameters // [] | join(", ")' <<<"$parameters")
[ -z "$missing" ] || fail "SSM parameters not found: $missing"
value() {
  jq -r --arg n "$1" '[.Parameters[] | select(.Name == $n) | .Value] | if length == 1 then .[0] else empty end' <<<"$parameters"
}
cluster=$(value "$cluster_name")
security_group=$(value "$security_group_name")
task_definition=$(value "$task_definition_name")
[ -n "$cluster" ] && [ -n "$security_group" ] && [ -n "$task_definition" ] ||
  fail "SSM did not return each parameter exactly once"
# 10-network publishes the subnet ids as a JSON list.
subnets=$(value "$subnets_name" | jq -r 'if type == "array" and length > 0 and all(type == "string") then join(",") else empty end' 2>/dev/null || true)
[ -n "$subnets" ] || fail "$subnets_name is not a non-empty JSON list of subnet ids"

started_by="deploy-$task-${RELEASE_ID:0:12}"
run=$(aws ecs run-task --region "$AWS_REGION" --output json \
  --cluster "$cluster" \
  --launch-type FARGATE \
  --task-definition "$task_definition" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$security_group],assignPublicIp=DISABLED}" \
  --started-by "$started_by" \
  --count 1)

failures=$(jq -c '.failures // []' <<<"$run")
[ "$failures" = "[]" ] || fail "ECS rejected the $task task: $failures"
task_arn=$(jq -r '.tasks // [] | if length == 1 then .[0].taskArn // empty else empty end' <<<"$run")
[ -n "$task_arn" ] || fail "ECS did not return exactly one task ARN"

echo "Waiting for the $task task $task_arn ..."
aws ecs wait tasks-stopped --region "$AWS_REGION" --cluster "$cluster" --tasks "$task_arn"

described=$(aws ecs describe-tasks --region "$AWS_REGION" --output json --cluster "$cluster" --tasks "$task_arn")
[ "$(jq '.tasks // [] | length' <<<"$described")" = 1 ] || fail "ECS returned no record of $task_arn"
[ "$(jq '.tasks[0].containers // [] | length' <<<"$described")" = 1 ] ||
  fail "the $task task must have exactly one container"

receipt=$(jq -c --arg task "$task" --arg release "$RELEASE_ID" '.tasks[0] | {
  task: $task,
  release_id: $release,
  task_arn: .taskArn,
  task_definition_arn: .taskDefinitionArn,
  exit_code: .containers[0].exitCode
}' <<<"$described")
echo "Deploy task receipt: $receipt"

exit_code=$(jq -r '.exit_code // "none"' <<<"$receipt")
if [ "$exit_code" != 0 ]; then
  reason=$(jq -r '.tasks[0] | .containers[0].reason // .stoppedReason // "unknown"' <<<"$described")
  fail "$task task failed with exit code $exit_code: $reason"
fi
