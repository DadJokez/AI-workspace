#!/usr/bin/env bash
# What 35-deploy-tasks plans inside its modules, read from the runs of
# deploy_tasks.tftest.hcl (see ../../../plan_checks.sh for how).
#
# These carry over what apps/web/__tests__/ecs-deploy-task-stack.test.ts
# asserts of the CDK stack this one replaces, where it still applies.
#
# No credentials, no state, no AWS calls.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../../../plan_checks.sh
source "$here/../../../plan_checks.sh"

collect_plans "$here/.."

app='"arn:aws:secretsmanager:us-east-1:111122223333:secret:comparative/unit/app-AbCdEf"'
image='"111122223333.dkr.ecr.us-east-1.amazonaws.com/cmp-unit-app@sha256:00000000000000000000000000000000000000000000000000000000000000'

migrator=module.migrator
smoke=module.smoke

check sandbox "two task definitions, two log groups, four roles, and no service" '
  (of_type("aws_ecs_task_definition") | length) == 2 and (of_type("aws_cloudwatch_log_group") | length) == 2
  and (of_type("aws_iam_role") | length) == 4 and (of_type("aws_ecs_service") | length) == 0'
check sandbox "both are Fargate tasks of 256/512" '
  of_type("aws_ecs_task_definition") | all(
    .values.cpu == "256" and .values.memory == "512" and .values.network_mode == "awsvpc"
    and .values.requires_compatibilities == ["FARGATE"])'
check sandbox "both images are given by digest" '
  of_type("aws_ecs_task_definition") | all(.values.container_definitions | fromjson | all(.image | test("@sha256:[0-9a-f]{64}$")))'

check sandbox "migrator: image_migrator with the image's own command" "
  resource(\"$migrator.aws_ecs_task_definition.this\").family == \"cmp-unit-migrator\"
  and (container(\"$migrator\") | .image == ${image}a1\" and (has(\"command\") | not))"
check sandbox "migrator: DATABASE_URL by reference, and no other secret (not NEXTAUTH_SECRET)" "
  secrets(\"$migrator\") == {DATABASE_URL: ($app + \":DATABASE_URL::\")}"
check sandbox "migrator: no environment variables" "
  environment(\"$migrator\") == {}"

check sandbox "smoke: image_worker running smoke:prod:auth" "
  resource(\"$smoke.aws_ecs_task_definition.this\").family == \"cmp-unit-smoke\"
  and (container(\"$smoke\") | .image == ${image}a2\"
    and .command == [\"pnpm\", \"--filter\", \"@ai-workspace/web\", \"smoke:prod:auth\"])"
check sandbox "smoke: DATABASE_URL and NEXTAUTH_SECRET by reference, and no other secret" "
  secrets(\"$smoke\") == {DATABASE_URL: ($app + \":DATABASE_URL::\"), NEXTAUTH_SECRET: ($app + \":NEXTAUTH_SECRET::\")}"
check sandbox "smoke: checks the public URL under the release id" "
  environment(\"$smoke\") == {
    SMOKE_BASE_URL: \"https://app.example.com\", SMOKE_RUN_ID: \"0123456789abcdef0123456789abcdef01234567\"}"
check internal_base_url "smoke: checks the internal URL when there is one" "
  environment(\"$smoke\").SMOKE_BASE_URL == \"https://internal.app.example.com\""

check sandbox "the execution roles read the app secret only; the tasks have no AWS permissions" "
  statement(\"$migrator.aws_iam_role_policy.execution\"; \"ReadTaskSecrets\").Resource == [$app]
  and statement(\"$smoke.aws_iam_role_policy.execution\"; \"ReadTaskSecrets\").Resource == [$app]
  and (of_type(\"aws_iam_role_policy\") | length) == 2"
check sandbox "every role is under /comparative/<env>/ with the workload boundary" '
  of_type("aws_iam_role") | all(
    .values.path == "/comparative/unit/"
    and .values.permissions_boundary == "arn:aws:iam::111122223333:policy/cmp-unit-workload-boundary")'
check sandbox "the log groups are /comparative/<env>/{migrator,smoke}, kept 30 days, encrypted" '
  (of_type("aws_cloudwatch_log_group") | all(
    .values.retention_in_days == 30
    and .values.kms_key_id == "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001"))
  and ([of_type("aws_cloudwatch_log_group")[].values.name] | sort) == ["/comparative/unit/migrator", "/comparative/unit/smoke"]'
# The database is reached through the deploy_task security group of
# 10-network, whose rules that stack owns and tests.
check sandbox "the stack creates no security group and no rule (those belong to 10-network)" '
  [.resources[] | select(.type | test("security_group"))] | length == 0'

finish
