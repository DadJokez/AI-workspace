#!/usr/bin/env bash
# No secret value may reach a plan, and so none may reach the state.
#
#   no_secret_in_plan.sh              plan tests/plan and check that plan
#   no_secret_in_plan.sh <plan.json>  check `terraform show -json` output of
#                                     any plan that contains the data module
#
# `terraform test` cannot show a plan file, so this is a real plan of
# tests/plan: no credentials, no state, no AWS calls. check.sh runs it in the
# test step.
#
# What is checked:
#   1. The plan is the one meant: it creates exactly one secret version, the
#      browser-proxy one, through the write-only argument. Without this the
#      checks below would pass on a plan that has no secret in it at all.
#   2. The password field appears nowhere. A secret string is JSON inside a
#      JSON string, so its field would read \"password\" in the plan.
#   3. The username stored beside the password appears nowhere either: it is a
#      canary for the secret string in any encoding of the field name.
#   4. No resource carries a secret argument, known now or only after apply
#      (a value known after apply is absent from the plan but lands in state).
#   5. No random_* managed resource exists: those keep their result in state.
#      The password generator must be ephemeral.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

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
  echo "no_secret_in_plan: $1" >&2
  status=1
}

# 1. The plan under test writes the browser-proxy secret, write-only.
jq -e '
  [.resource_changes[] | select(.mode == "managed" and .type == "aws_secretsmanager_secret_version")] as $versions
  | ($versions | length) == 1
  and ($versions[0].name == "browser_proxy")
  and ($versions[0].change.actions == ["create"])
  and ($versions[0].change.after.secret_string_wo_version != null)
' "$plan_json" >/dev/null ||
  fail "expected exactly one secret version, browser_proxy, created through secret_string_wo"

jq -e '
  [.. | objects | select(.type? == "aws_secretsmanager_secret_version" and .expressions? != null)
   | .expressions.secret_string_wo.references // [] | .[]]
  | any(startswith("ephemeral.random_password."))
' "$plan_json" >/dev/null ||
  fail "the browser-proxy secret must take its password from ephemeral.random_password"

# 2. The password field of a secret string.
if grep -qF '\"password\"' "$plan_json"; then
  fail 'the plan contains a \"password\" field: a secret string is in the plan'
fi

# 3. The username that is stored beside the password.
if grep -qF 'comparative-browser' "$plan_json"; then
  fail "the plan contains the browser-proxy username: the secret string is in the plan"
fi

# 4. Secret arguments must be null: neither set nor known after apply.
leaks=$(jq -r '
  ["password", "password_wo", "master_password", "secret_string", "secret_string_wo", "secret_binary"] as $secret
  | .resource_changes[]
  | select(.mode == "managed")
  | .address as $address
  | (
      (.change.after // {} | to_entries[] | select(.key as $key | $secret | index($key)) | select(.value != null)
       | "\($address).\(.key) has a value in the plan"),
      (.change.after_unknown // {} | to_entries[] | select(.key as $key | $secret | index($key)) | select(.value == true)
       | "\($address).\(.key) is known after apply, so it would be stored in state")
    )
' "$plan_json")
if [ -n "$leaks" ]; then
  fail "secret arguments are set:"
  echo "$leaks" >&2
fi

# 5. No generator that keeps its result in state.
generators=$(jq -r '.resource_changes[] | select(.mode == "managed" and (.type | startswith("random_"))) | .address' "$plan_json")
if [ -n "$generators" ]; then
  fail "random_* managed resources keep their result in state; use an ephemeral resource:"
  echo "$generators" >&2
fi

if [ "$status" -eq 0 ]; then
  echo "ok  no secret value in the plan"
fi
exit "$status"
