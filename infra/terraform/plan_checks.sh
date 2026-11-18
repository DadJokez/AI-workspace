#!/usr/bin/env bash
# Checks on what a stack plans inside its modules. Sourced by
# stacks/<stack>/tests/*.sh; check.sh runs those in the test step.
#
# A `terraform test` file can assert only on what the root module sees. But
# `terraform test -json -verbose` prints the plan of every run (and the state
# of a run that applies), mocked provider and all, and those hold every
# resource of every module. This file collects them and checks them with jq:
#
#   source "$here/../../../plan_checks.sh"
#   collect_plans "$here/.."          # runs the stack's test files
#   check <run> "<what must hold>" '<jq filter that must be true>'
#   finish
#
# No credentials, no real state, no AWS calls: the same mocked runs as
# `terraform test`.
#
# A check fails closed. Its filter must produce `true`; a resource or run that
# does not exist produces nothing, and that is a failure.

plan_checks_status=0
plan_checks_file=

# Helpers every filter can use. Input is one run:
#   {run, resources: [{address, type, actions, values}]}
# `actions` is the planned change (["no-op"], ["update"], ["create"], ...) and
# is null for a run that applied.
plan_checks_defs='
  def resource(address): first(.resources[] | select(.address == address) | .values);
  def of_type(type): [.resources[] | select(.type == type)];
  def changed: [.resources[] | select(.actions != null and .actions != ["no-op"])];
  def container(task): resource(task + ".aws_ecs_task_definition.this").container_definitions | fromjson | .[0];
  def environment(task): container(task).environment | map({(.name): .value}) | add // {};
  def secrets(task): container(task).secrets | map({(.name): .valueFrom}) | add // {};
  def statements(address): resource(address).policy | fromjson | .Statement;
  def statement(address; sid): first(statements(address)[] | select(.Sid == sid));
'

# collect_plans <stack directory>
collect_plans() {
  local stack_dir=$1
  plan_checks_file=$(mktemp)
  trap 'rm -f "$plan_checks_file"' EXIT

  terraform -chdir="$stack_dir" init -backend=false -input=false >/dev/null
  # Each event carries the provider schema, tens of megabytes; jq drops it as
  # the events stream past.
  if ! terraform -chdir="$stack_dir" test -json -verbose | jq -c '
    def modules: ., (.child_modules[]? | modules);
    if .type == "test_plan" then {
      run: ."@testrun",
      resources: [.test_plan.resource_changes[] | select(.mode == "managed")
        | {address, type, actions: .change.actions, values: .change.after}]
    } elif .type == "test_state" then {
      run: ."@testrun",
      resources: [.test_state.root_module | modules | .resources[]? | select(.mode == "managed")
        | {address, type, actions: null, values}]
    } else empty end
  ' >"$plan_checks_file"; then
    echo "plan_checks: \`terraform test\` failed in $stack_dir; run it there for the reason" >&2
    exit 1
  fi
}

# check <run> <description> <jq filter>
check() {
  local run=$1 description=$2 filter=$3
  if jq -e --arg run "$run" "$plan_checks_defs select(.run == \$run) | ($filter) == true" \
    "$plan_checks_file" >/dev/null 2>&1; then
    echo "ok    $run: $description"
  else
    echo "FAIL  $run: $description" >&2
    plan_checks_status=1
  fi
}

finish() {
  exit "$plan_checks_status"
}
