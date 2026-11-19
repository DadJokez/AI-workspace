#!/usr/bin/env bash
# Fixtures for affected.sh: which (environment, stack) pairs a change plans
# and applies. A pair left out is never planned on the pull request and never
# applied on merge, so every rule is pinned here.
#
# Runs against a throwaway Terraform tree with two environments; the last
# cases run against the real tree.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/affected.sh"
pass=0
fail=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ok() {
  echo "  ok   $1"
  pass=$((pass + 1))
}
bad() { # name detail
  echo "  FAIL $1"
  printf '%s\n' "$2" | sed 's/^/       /'
  fail=$((fail + 1))
}

# A tree like infra/terraform: two environments, the stacks of today, and the
# module references they have (ecs-service uses ecs-task).
root="$tmp/infra/terraform"
mkdir -p "$root"
for env_name in personal-prod personal-stage; do
  mkdir -p "$root/envs/$env_name"
done
stack_with() { # stack [module...]
  local stack=$1 module
  shift
  mkdir -p "$root/stacks/$stack"
  : > "$root/stacks/$stack/main.tf"
  for module in "$@"; do
    printf 'module "%s" {\n  source = "../../modules/%s"\n}\n' "$module" "$module" >> "$root/stacks/$stack/main.tf"
  done
}
stack_with 00-foundation ci-identity
stack_with 10-network network
stack_with 20-data data
stack_with 30-platform
stack_with 35-deploy-tasks ecs-task
stack_with 40-services ecs-service
stack_with 60-observability observability
for module in ci-identity network data ecs-task ecs-service observability unused; do
  mkdir -p "$root/modules/$module/tests"
  : > "$root/modules/$module/main.tf"
done
printf 'module "task" {\n  source = "../ecs-task"\n}\n' > "$root/modules/ecs-service/main.tf"
# A test of a module that references another is not a use of it.
printf 'module "under_test" {\n  source = "../../network"\n}\n' > "$root/modules/unused/tests/main.tf"

# name expected-output path...
check() {
  local name=$1 expected=$2 actual status
  shift 2
  actual=$(printf '%s\0' "$@" | bash "$script" "$root" 2>&1)
  status=$?
  if [ "$status" = 0 ] && [ "$actual" = "$(printf '%b' "$expected")" ]; then
    ok "$name"
  else
    bad "$name" "exit $status; expected:
$(printf '%b' "$expected")
got:
$actual"
  fi
}

T=infra/terraform

echo "affected.sh:"

check "a release affects 35-deploy-tasks and 40-services of that environment only" \
  'personal-stage\t35-deploy-tasks\trelease\npersonal-stage\t40-services\trelease' \
  "$T/envs/personal-stage/release.auto.tfvars"

check "env.tfvars affects every stack of that environment" \
  'personal-stage\t00-foundation\tinfra\npersonal-stage\t10-network\tinfra\npersonal-stage\t20-data\tinfra\npersonal-stage\t30-platform\tinfra\npersonal-stage\t35-deploy-tasks\tinfra\npersonal-stage\t40-services\tinfra\npersonal-stage\t60-observability\tinfra' \
  "$T/envs/personal-stage/env.tfvars"

check "backend.hcl affects every stack of that environment" \
  'personal-prod\t00-foundation\tinfra\npersonal-prod\t10-network\tinfra\npersonal-prod\t20-data\tinfra\npersonal-prod\t30-platform\tinfra\npersonal-prod\t35-deploy-tasks\tinfra\npersonal-prod\t40-services\tinfra\npersonal-prod\t60-observability\tinfra' \
  "$T/envs/personal-prod/backend.hcl"

check "a stack change affects that stack in every environment" \
  'personal-prod\t10-network\tinfra\npersonal-stage\t10-network\tinfra' \
  "$T/stacks/10-network/main.tf"

check "a stack's tests count as a change of the stack" \
  'personal-prod\t60-observability\tinfra\npersonal-stage\t60-observability\tinfra' \
  "$T/stacks/60-observability/tests/observability.tftest.hcl"

check "a module change affects every stack that uses it, through other modules too" \
  'personal-prod\t35-deploy-tasks\tinfra\npersonal-prod\t40-services\tinfra\npersonal-stage\t35-deploy-tasks\tinfra\npersonal-stage\t40-services\tinfra' \
  "$T/modules/ecs-task/variables.tf"

check "ci-identity affects 00-foundation" \
  'personal-prod\t00-foundation\tinfra\npersonal-stage\t00-foundation\tinfra' \
  "$T/modules/ci-identity/main.tf"

check "a module nothing uses affects nothing (its tests' references are not uses)" '' \
  "$T/modules/unused/main.tf"

check "a release and a module change together: release, infra and both" \
  'personal-prod\t40-services\tinfra\npersonal-stage\t35-deploy-tasks\trelease\npersonal-stage\t40-services\tboth' \
  "$T/envs/personal-stage/release.auto.tfvars" "$T/modules/ecs-service/main.tf"

check "tf.sh affects every pair" \
  "$(for e in personal-prod personal-stage; do for s in 00-foundation 10-network 20-data 30-platform 35-deploy-tasks 40-services 60-observability; do printf '%s\\t%s\\tinfra\\n' "$e" "$s"; done; done | sed '$ s/\\n$//')" \
  "$T/tf.sh"

check "documentation, checks, policy, scripts and bootstrap affect nothing" '' \
  "$T/README.md" "$T/check.sh" "$T/plan_checks.sh" "$T/policy/lib.rego" \
  "$T/scripts/affected.sh" "$T/bootstrap/main.tf" "$T/versions.tf.tmpl"

check "paths outside infra/terraform affect nothing" '' \
  "apps/web/app/page.tsx" ".github/workflows/terraform-plan.yml" "docs/infra/terraform/envs/personal-stage/env.tfvars"

check "an environment or stack that no longer exists is left out" '' \
  "$T/envs/personal-dev/env.tfvars" "$T/stacks/90-gone/main.tf" "$T/envs/personal-dev/release.auto.tfvars"

check "no change, no pair" ''

mkdir -p "$root/stacks/50-agentcore"
check "50-agentcore, once it exists, is released and ordered before 40-services" \
  'personal-stage\t35-deploy-tasks\trelease\npersonal-stage\t50-agentcore\trelease\npersonal-stage\t40-services\trelease' \
  "$T/envs/personal-stage/release.auto.tfvars"

mkdir -p "$root/stacks/45-new"
out=$(printf '%s\0' "$T/stacks/10-network/main.tf" | bash "$script" "$root" 2>&1)
status=$?
if [ "$status" = 1 ] && [[ "$out" == *"stacks/45-new is not in the apply order"* ]]; then
  ok "a stack missing from the apply order is an error, not a silent skip"
else
  bad "a stack missing from the apply order is an error, not a silent skip" "exit $status: $out"
fi
rmdir "$root/stacks/45-new"

out=$(bash "$script" "$root" extra < /dev/null 2>&1)
status=$?
if [ "$status" = 2 ] && [[ "$out" == *"usage:"* ]]; then
  ok "two arguments are a usage error"
else
  bad "two arguments are a usage error" "exit $status: $out"
fi

# The real tree: every stack directory is in the apply order, and a release of
# personal-stage plans the release stacks that exist.
out=$(printf '%s\0' "$T/envs/personal-stage/release.auto.tfvars" | bash "$script" 2>&1)
status=$?
expected=$(printf 'personal-stage\t35-deploy-tasks\trelease\n')
[ -d "$here/../stacks/50-agentcore" ] && expected+=$(printf '\npersonal-stage\t50-agentcore\trelease')
expected+=$(printf '\npersonal-stage\t40-services\trelease')
if [ "$status" = 0 ] && [ "$out" = "$expected" ]; then
  ok "the real tree: a personal-stage release affects its release stacks"
else
  bad "the real tree: a personal-stage release affects its release stacks" "exit $status: $out"
fi

echo
echo "affected.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
