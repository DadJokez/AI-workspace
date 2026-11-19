#!/usr/bin/env bash
# stack.sh — one stack of one environment, the way the plan and apply
# workflows run it. Every mode plans through tf.sh into <out dir>, reads the
# plan as JSON and checks it against the Conftest rules of policy/.
#
#   stack.sh plan <env> <stack> <out dir>
#       The pull-request plan, read-only: no state lock (the plan role may
#       not write the lock file). Writes plan.tfplan, plan.json, summary.md,
#       policy.txt and report.json. Fails only when the plan itself fails;
#       the caller decides on the policy and stateful results in report.json.
#
#   stack.sh check <env> <stack> <out dir>
#       For a stack a human applies (README, "What the apply role cannot
#       do"): read-only like `plan`, and fails when the stack has changes
#       that are not applied yet.
#
#   stack.sh drift <env> <stack> <out dir>
#       The drift workflow's plan: read-only like `plan`, with
#       -detailed-exitcode, which tells "no changes" (0) from "changes" (2).
#       Also writes outside.md (what changed outside Terraform) and sets
#       `drift` in report.json. Passes whether or not there is drift; fails
#       when the plan fails. The environment, the stack and the placeholders
#       are checked first, so that tf.sh's own exit code 2 (a usage error)
#       can never be read as "changes".
#
#   stack.sh apply <env> <stack> <out dir> [<reviewed report.json>]
#       Plans with the state lock and applies exactly that plan, unless it
#       changes nothing. Refused when a rule rejects the plan; when a reviewed
#       report is given and the plan's fingerprint differs from it; and when
#       the plan destroys or replaces a stateful resource, unless the plan is
#       exactly the reviewed one and ALLOW_STATEFUL_REPLACE=true. The caller
#       sets that only after checking, with its own copy of
#       stateful-replace-allowed.sh, that a human labelled the merged pull
#       request allow-stateful-replace: the reviewed report was written by the
#       pull request's own run, so it cannot be what allows it.
#
# report.json: {env, stack, changes, fingerprint, stateful: [address],
#               policy_ok, policy_failures: [message], applied}, and in
#              drift mode also drift: true|false
# exit: 0 on success, 1 when refused or Terraform fails, 2 on a usage error.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/.." && pwd)

usage() {
  echo "usage: stack.sh <plan|check|drift|apply> <env> <stack> <out dir> [<reviewed report.json>]" >&2
  exit 2
}
[ "$#" -ge 4 ] || usage
mode=$1 env_name=$2 stack=$3 out=$4
reviewed=${5:-}
case "$mode" in
  plan | check | drift) [ "$#" -eq 4 ] || usage ;;
  apply) [ "$#" -le 5 ] || usage ;;
  *) usage ;;
esac
[[ "$env_name" =~ ^[a-z0-9-]+$ ]] && [[ "$stack" =~ ^[0-9]{2}-[a-z0-9-]+$ ]] || usage
[ -z "$reviewed" ] || [ -f "$reviewed" ] || { echo "stack.sh: no reviewed report at $reviewed" >&2; exit 2; }

refuse() {
  echo "stack.sh: $env_name/$stack: $*" >&2
  exit 1
}

mkdir -p "$out"
out=$(cd "$out" && pwd)
plan_file="$out/plan.tfplan"

plan_args=(-lock=false)
case "$mode" in
  apply) plan_args=() ;;
  drift)
    plan_args+=(-detailed-exitcode)
    [ -d "$root/envs/$env_name" ] || refuse "no such environment"
    [ -d "$root/stacks/$stack" ] || refuse "no such stack"
    "$here/placeholders.sh" "$root/envs/$env_name" > /dev/null || refuse "envs/$env_name still has placeholder values"
    ;;
esac
plan_exit=0
"$root/tf.sh" "$env_name" "$stack" plan -input=false "${plan_args[@]}" -out="$plan_file" || plan_exit=$?
if [ "$mode" = drift ]; then
  case "$plan_exit" in
    0 | 2) ;;
    *) refuse "the plan failed (exit $plan_exit)" ;;
  esac
elif [ "$plan_exit" != 0 ]; then
  exit "$plan_exit"
fi
terraform -chdir="$root/stacks/$stack" show -json "$plan_file" > "$out/plan.json"

policy_ok=true
if ! conftest test --policy "$root/policy" --no-color --output json "$out/plan.json" > "$out/policy.json"; then
  policy_ok=false
fi
jq -r '[.[].failures[]?.msg] | .[]' "$out/policy.json" > "$out/policy.txt" 2>/dev/null || {
  echo "conftest produced no readable result" > "$out/policy.txt"
  policy_ok=false
}

"$here/plan-report.sh" summary "$out/plan.json" > "$out/summary.md"
changes=$("$here/plan-report.sh" changes "$out/plan.json")
fingerprint=$("$here/plan-report.sh" fingerprint "$out/plan.json")
"$here/plan-report.sh" stateful "$out/plan.json" > "$out/stateful.txt"

write_report() { # applied
  jq -n --arg env "$env_name" --arg stack "$stack" --argjson changes "$changes" \
    --arg fingerprint "$fingerprint" --argjson policy_ok "$policy_ok" --argjson applied "$1" \
    --rawfile stateful "$out/stateful.txt" --rawfile policy "$out/policy.txt" '{
      env: $env, stack: $stack, changes: $changes, fingerprint: $fingerprint,
      stateful: ($stateful | split("\n") | map(select(. != "") | split("\t")[0])),
      policy_ok: $policy_ok,
      policy_failures: ($policy | split("\n") | map(select(. != ""))),
      applied: $applied
    }' > "$out/report.json"
}
write_report false
echo "$env_name/$stack: $changes change(s), fingerprint $fingerprint"

case "$mode" in
  plan) exit 0 ;;
  drift)
    drift=false
    [ "$plan_exit" = 0 ] || drift=true
    "$here/plan-report.sh" outside "$out/plan.json" > "$out/outside.md"
    jq --argjson drift "$drift" '.drift = $drift' "$out/report.json" > "$out/report.json.new"
    mv "$out/report.json.new" "$out/report.json"
    echo "$env_name/$stack: drift=$drift"
    exit 0
    ;;
  check)
    [ "$policy_ok" = true ] || refuse "a policy rule rejects the plan: $(paste -sd ';' "$out/policy.txt")"
    [ "$changes" = 0 ] ||
      refuse "has $changes change(s) the pipeline may not apply; a human applies this stack (infra/terraform/README.md), then re-runs this job"
    exit 0
    ;;
esac

# apply
[ "$policy_ok" = true ] || refuse "a policy rule rejects the plan: $(paste -sd ';' "$out/policy.txt")"
if [ "$changes" = 0 ]; then
  echo "$env_name/$stack: nothing to apply"
  exit 0
fi

matched=false
if [ -n "$reviewed" ]; then
  reviewed_fingerprint=$(jq -r '.fingerprint // ""' "$reviewed")
  [ "$fingerprint" = "$reviewed_fingerprint" ] ||
    refuse "the plan differs from the one reviewed on the pull request (fingerprint $fingerprint, reviewed ${reviewed_fingerprint:-none}); open a pull request that shows the plan as it is now"
  matched=true
fi
if [ -s "$out/stateful.txt" ]; then
  [ "$matched" = true ] && [ "${ALLOW_STATEFUL_REPLACE:-}" = true ] ||
    refuse "the plan destroys or replaces stateful resources and was not reviewed with allow-stateful-replace: $(cut -f1 "$out/stateful.txt" | paste -sd ' ')"
fi

"$root/tf.sh" "$env_name" "$stack" apply -input=false "$plan_file"
write_report true
