#!/usr/bin/env bash
# Every Conftest rule in policy/ accepts what this module plans.
#
#   policy_on_plan.sh              plan tests/plan and check that plan
#   policy_on_plan.sh <plan.json>  check `terraform show -json` output of any
#                                  plan that contains the observability module
#
# `terraform test` cannot show a plan file, so this is a real plan of
# tests/plan: no credentials, no state, no AWS calls. check.sh runs it in the
# test step.
#
# What is checked:
#   1. The plan is the one meant: the topic and its policy, ten alarms, two
#      metric filters, the dashboard and a subscription. Without this the
#      checks below would pass on an empty plan.
#   2. The rules of policy/ produce no failure (required tags and the rest).
#   3. The topic is encrypted with a customer-managed key. No rule of policy/
#      covers SNS, so it is stated here.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
policy="$here/../../../policy"

if [ "$#" -ge 1 ]; then
  plan_json=$1
else
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  plan_json="$work/plan.json"
  terraform -chdir="$here/plan" init -backend=false -input=false >/dev/null
  terraform -chdir="$here/plan" plan -input=false -lock=false -out="$work/plan.tfplan" >/dev/null
  terraform -chdir="$here/plan" show -json "$work/plan.tfplan" >"$plan_json"
fi

status=0
fail() {
  echo "policy_on_plan: $1" >&2
  status=1
}

# 1. The plan under test.
jq -e '
  [.resource_changes[] | select(.mode == "managed" and .change.actions == ["create"]) | .type]
  | group_by(.) | map({(.[0]): length}) | add
  == {
    aws_cloudwatch_dashboard: 1,
    aws_cloudwatch_log_metric_filter: 2,
    aws_cloudwatch_metric_alarm: 10,
    aws_sns_topic: 1,
    aws_sns_topic_policy: 1,
    aws_sns_topic_subscription: 1
  }
' "$plan_json" >/dev/null ||
  fail "expected a plan that creates the topic, its policy, a subscription, two metric filters, ten alarms and the dashboard"

# 2. The rules.
if ! conftest test --policy "$policy" --no-color "$plan_json"; then
  fail "a rule of policy/ rejects the plan"
fi

# 3. Encryption of the topic.
jq -e '
  [.resource_changes[] | select(.type == "aws_sns_topic")]
  | length == 1 and all(.change.after.kms_master_key_id | test("^arn:aws:kms:.+:key/.+"))
' "$plan_json" >/dev/null ||
  fail "the ops alert topic must be encrypted with a customer-managed KMS key"

if [ "$status" -eq 0 ]; then
  echo "ok  the policy rules accept the plan, and the topic is encrypted"
fi
exit "$status"
