#!/usr/bin/env bash
# Every Conftest rule in policy/ accepts what this module plans, and the
# runtime role allows no Bedrock action on Resource "*".
#
#   policy_on_plan.sh              plan tests/plan and check that plan
#   policy_on_plan.sh <plan.json>  check `terraform show -json` output of any
#                                  plan that contains the agentcore module
#
# `terraform test` cannot show a plan file, so this is a real plan of
# tests/plan: no credentials, no state, no AWS calls. check.sh runs it in the
# test step.
#
# What is checked:
#   1. The plan is the one meant: the runtime, the browser, the credential
#      provider, two roles and three role policies. Without this the checks
#      below would pass on an empty plan.
#   2. The rules of policy/ produce no failure (required tags,
#      iam-bedrock-scope and the rest).
#   3. No Allow statement of the runtime role's policies names a bedrock: or
#      bedrock-agentcore: action together with Resource "*". iam-bedrock-scope
#      covers bedrock:InvokeModel* in every policy; this covers every Bedrock
#      action of the runtime role. A policy that is only known after apply (the
#      web-search one names the credential provider's ARN) is checked by
#      agentcore.tftest.hcl instead.
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
    aws_bedrockagentcore_agent_runtime: 1,
    aws_bedrockagentcore_api_key_credential_provider: 1,
    aws_bedrockagentcore_browser: 1,
    aws_iam_role: 2,
    aws_iam_role_policy: 3
  }
' "$plan_json" >/dev/null ||
  fail "expected a plan that creates the runtime, the browser, the credential provider, two roles and three role policies"

# 2. The rules.
if ! conftest test --policy "$policy" --no-color "$plan_json"; then
  fail "a rule of policy/ rejects the plan"
fi

# 3. The runtime role and Resource "*".
jq -e '
  [.resource_changes[]
    | select(.type == "aws_iam_role_policy" and (.address | test("\\.aws_iam_role_policy\\.runtime(_web_search)?(\\[0\\])?$")))
    | .change.after.policy | select(. != null) | fromjson | .Statement
    | if type == "array" then .[] else . end
    | select(.Effect == "Allow")
    | select([.Resource] | flatten | index("*") != null)
    | select([.Action] | flatten | any(ascii_downcase | startswith("bedrock")))
  ] | length == 0
' "$plan_json" >/dev/null ||
  fail "the runtime role allows a bedrock or bedrock-agentcore action on Resource \"*\""

jq -e '[.resource_changes[] | select(.address == "module.agentcore.aws_iam_role_policy.runtime") | .change.after.policy | select(. != null)] | length == 1' \
  "$plan_json" >/dev/null ||
  fail "the runtime role's policy must be known at plan time, so that the check above reads it"

if [ "$status" -eq 0 ]; then
  echo "ok  the policy rules accept the plan, and the runtime role allows no Bedrock action on Resource \"*\""
fi
exit "$status"
