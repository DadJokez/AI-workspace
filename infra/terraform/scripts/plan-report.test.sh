#!/usr/bin/env bash
# Fixtures for plan-report.sh: the summary posted on a pull request, the
# stateful-replace detector that fails a plan, and the fingerprint that ties
# an apply to the plan that was reviewed.
#
# fixtures/plan-report/mixed.json holds one of everything: updates, a create,
# replacements both ways round, deletes, a forget, a no-op, a data read, a
# value that must not reach a comment (hunter2-not-a-real-value) and a
# for_each key that is a configuration value (an email address).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/plan-report.sh"
fixtures="$here/fixtures/plan-report"
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
expect() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected:
$2
got:
$3"; fi
}

mixed="$fixtures/mixed.json"
none="$fixtures/no-changes.json"
# A variant of mixed.json: jq filter -> file
variant() {
  jq "$1" "$mixed" > "$tmp/variant.json"
  echo "$tmp/variant.json"
}

echo "summary:"

summary=$(bash "$script" summary "$mixed")
expect "totals count each change once, by what happens to it" \
  "**2 to add, 3 to change, 3 to replace, 2 to destroy** (and 1 other: forget)" \
  "$(head -n 1 <<<"$summary")"
# shellcheck disable=SC2016 # the backticks are Markdown, not a command
expect "one row per resource type with its counts" \
  '| `aws_cloudwatch_log_group` | 0 | 0 | 0 | 0 | 1 |
| `aws_db_instance` | 0 | 0 | 1 | 0 | 0 |
| `aws_ecr_repository` | 0 | 0 | 1 | 0 | 0 |
| `aws_ecs_service` | 0 | 2 | 0 | 0 | 0 |
| `aws_ecs_task_definition` | 0 | 0 | 1 | 0 | 0 |
| `aws_iam_role` | 1 | 0 | 0 | 0 | 0 |
| `aws_s3_bucket` | 0 | 0 | 0 | 1 | 0 |
| `aws_secretsmanager_secret` | 0 | 1 | 0 | 0 | 0 |
| `aws_sns_topic_subscription` | 1 | 0 | 0 | 0 | 0 |
| `aws_ssm_parameter` | 0 | 0 | 0 | 1 | 0 |' \
  "$(grep '^| `' <<<"$summary")"
if grep -qE 'hunter2|example\.com|cmp-unit|arn:|module\.|old/key' <<<"$summary"; then
  bad "the summary carries no value, address or for_each key" "$summary"
else
  ok "the summary carries no value, address or for_each key"
fi
expect "no-op resources and data reads are not changes" "No changes to resources." \
  "$(bash "$script" summary "$none")"

echo "outside:"

drift="$fixtures/drift.json"
outside=$(bash "$script" outside "$drift")
expect "totals of what changed outside Terraform" \
  "**Changed outside Terraform: 2 changed, 1 deleted**" "$(head -n 1 <<<"$outside")"
# shellcheck disable=SC2016 # the backticks are Markdown, not a command
expect "one row per resource type changed outside Terraform" \
  '| `aws_ssm_parameter` | 1 | 1 |
| `aws_vpc_security_group_ingress_rule` | 1 | 0 |' \
  "$(grep '^| `' <<<"$outside")"
if grep -qE 'hunter2|console|sgr-|sg-0|module\.|sg/|web-from-alb' <<<"$outside"; then
  bad "the outside summary carries no value, address or for_each key" "$outside"
else
  ok "the outside summary carries no value, address or for_each key"
fi
expect "a plan without resource_drift changed nothing outside" "Nothing changed outside Terraform." \
  "$(bash "$script" outside "$mixed")"

echo "changes:"

expect "every changed managed resource counts, nothing else" 11 "$(bash "$script" changes "$mixed")"
expect "a plan of no-ops and reads changes nothing" 0 "$(bash "$script" changes "$none")"
expect "a changed output counts" 1 \
  "$(bash "$script" changes "$(jq '.output_changes.x = {actions: ["create"], after: "v", after_unknown: false}' "$none" > "$tmp/out.json" && echo "$tmp/out.json")")"

echo "stateful:"

expect "replacements and deletions of databases, buckets and repositories are found" \
  "$(printf 'module.data.aws_db_instance.this\tdelete,create\nmodule.data.aws_s3_bucket.this["artifacts"]\tdelete\naws_ecr_repository.this["app"]\tcreate,delete')" \
  "$(bash "$script" stateful "$mixed")"
expect "a stateful type that is only updated or left alone is not" "" \
  "$(bash "$script" stateful "$(variant '.resource_changes |= map(select(.type != "aws_db_instance" and .type != "aws_s3_bucket" and .type != "aws_ecr_repository"))')")"
expect "a KMS key scheduled for deletion is found" \
  "$(printf 'aws_kms_key.symmetric["data"]\tdelete')" \
  "$(bash "$script" stateful "$(variant '(.resource_changes[] | select(.type == "aws_kms_key") | .change.actions) = ["delete"] | .resource_changes |= map(select(.type == "aws_kms_key"))')")"
expect "a replaced secret is found" \
  "$(printf 'module.data.aws_secretsmanager_secret.this["app"]\tdelete,create')" \
  "$(bash "$script" stateful "$(variant '(.resource_changes[] | select(.type == "aws_secretsmanager_secret") | .change.actions) = ["delete", "create"] | .resource_changes |= map(select(.type == "aws_secretsmanager_secret"))')")"
expect "a destroyed task definition or parameter is not stateful" "" \
  "$(bash "$script" stateful "$(variant '.resource_changes |= map(select(.type == "aws_ecs_task_definition" or .type == "aws_ssm_parameter"))')")"
expect "a plan with no changes has nothing stateful" "" "$(bash "$script" stateful "$none")"

echo "fingerprint:"

base=$(bash "$script" fingerprint "$mixed")
if [[ "$base" =~ ^[0-9a-f]{64}$ ]]; then ok "a fingerprint is a sha256"; else bad "a fingerprint is a sha256" "$base"; fi
expect "the order of resource changes does not matter" "$base" \
  "$(bash "$script" fingerprint "$(variant '.resource_changes |= reverse')")"
expect "the state before, the timestamp and the versions do not matter" "$base" \
  "$(bash "$script" fingerprint "$(variant '.timestamp = "2027-01-01T00:00:00Z" | .terraform_version = "1.17.3" | .prior_state = {x: 1} | .resource_drift = [{}] | .resource_changes[0].change.before = {task_definition: "other"}')")"
expect "no-op resources and data reads do not matter" "$base" \
  "$(bash "$script" fingerprint "$(variant '.resource_changes |= map(select(.change.actions != ["no-op"] and .change.actions != ["read"]))')")"
differs() { # name filter
  local other
  other=$(bash "$script" fingerprint "$(variant "$2")")
  if [ "$other" != "$base" ]; then ok "$1"; else bad "$1" "fingerprint did not change"; fi
}
differs "a different planned value changes it" '.resource_changes[1].change.after.desired_count = 3'
differs "a different action changes it" '.resource_changes[0].change.actions = ["delete", "create"]'
differs "a value becoming unknown changes it" '.resource_changes[3].change.after_unknown.name = true'
differs "one more changed resource changes it" '.resource_changes += [.resource_changes[3] | .address = "aws_iam_role.another"]'
differs "a changed output changes it" '.output_changes.service_names.actions = ["update"]'
expect "a fingerprint of no changes is the same for any such plan" \
  "$(bash "$script" fingerprint "$none")" \
  "$(bash "$script" fingerprint "$(jq '.resource_changes = []' "$none" > "$tmp/empty.json" && echo "$tmp/empty.json")")"

echo "errors:"

echo '{"not": "a plan"}' > "$tmp/not-a-plan.json"
out=$(bash "$script" summary "$tmp/not-a-plan.json" 2>&1)
status=$?
if [ "$status" = 1 ] && [[ "$out" == *"is not the JSON of a plan"* ]]; then
  ok "input that is not a plan is refused"
else
  bad "input that is not a plan is refused" "exit $status: $out"
fi
out=$(bash "$script" verdict "$mixed" 2>&1)
status=$?
if [ "$status" = 2 ] && [[ "$out" == *"usage:"* ]]; then
  ok "an unknown command is a usage error"
else
  bad "an unknown command is a usage error" "exit $status: $out"
fi
out=$(bash "$script" summary "$tmp/missing.json" 2>&1)
status=$?
if [ "$status" = 2 ]; then ok "a missing file is a usage error"; else bad "a missing file is a usage error" "exit $status: $out"; fi

echo
echo "plan-report.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
