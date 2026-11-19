#!/usr/bin/env bash
# Fixtures for drift-issue.sh: when the drift workflow opens or refreshes an
# environment's issue (drift), closes it (clean) or leaves it alone (unknown),
# the deadline of the one-working-day rule, and what the issue says.
#
# The reports are written here the way terraform-drift.yml writes them, from
# the plan fixtures of plan-report.sh. No credentials, no AWS calls.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/drift-issue.sh"
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

drift_plan="$here/fixtures/plan-report/drift.json"
none_plan="$here/fixtures/plan-report/no-changes.json"
run_url="https://github.com/example-owner/example-repo/actions/runs/42"

# report <dir> <stack> <outcome> [<plan fixture> [<live rules json>]]: what one
# plan job of terraform-drift.yml uploads. Without a fixture, nothing but the
# result (a plan that failed before the security group step).
report() {
  local dir="$1/drift-unit-$2"
  mkdir -p "$dir"
  jq -n --arg o "$3" '{env: "unit", outcome: $o}' > "$dir/result.json"
  [ -n "${4:-}" ] || return 0
  bash "$here/plan-report.sh" summary "$4" > "$dir/summary.md"
  bash "$here/plan-report.sh" outside "$4" > "$dir/outside.md"
  bash "$here/sg-rules.sh" managed "$4" > "$dir/sg-managed.json"
  echo "${5:-[]}" > "$dir/sg-live.json"
}
# The live rules of the drift fixture's groups, all of them managed.
managed_live='[{"id":"sgr-0albhttps","group":"sg-0alb","egress":false},{"id":"sgr-0albtoweb","group":"sg-0alb","egress":true},{"id":"sgr-0webfromalb","group":"sg-0web","egress":false}]'
with_console_rule='[{"id":"sgr-0albhttps","group":"sg-0alb","egress":false},{"id":"sgr-0albtoweb","group":"sg-0alb","egress":true},{"id":"sgr-0webfromalb","group":"sg-0web","egress":false},{"id":"sgr-0console","group":"sg-0web","egress":false}]'

evaluate() { # reports dir, stacks... -> the evaluation JSON
  local dir=$1
  shift
  bash "$script" evaluate unit "$dir" "$@"
}
field() { jq -c "$1" <<<"$2"; }

echo "evaluate:"

r="$tmp/clean"
report "$r" 10-network clean "$drift_plan" "$managed_live"
report "$r" 20-data clean "$none_plan"
e=$(evaluate "$r" 10-network 20-data)
expect "every stack without changes and every rule managed: clean" '"clean"' "$(field .status "$e")"
expect "the rules were checked and none is outside Terraform" 'true []' "$(field .rules_checked "$e") $(field .unmanaged_rules "$e")"
expect "each stack with its outcome" '[{"stack":"10-network","outcome":"clean"},{"stack":"20-data","outcome":"clean"}]' "$(field .stacks "$e")"

r="$tmp/drift"
report "$r" 10-network drift "$drift_plan" "$managed_live"
report "$r" 20-data clean "$none_plan"
e=$(evaluate "$r" 10-network 20-data)
expect "a stack with changes: drift" '"drift"' "$(field .status "$e")"

r="$tmp/console-rule"
report "$r" 10-network clean "$drift_plan" "$with_console_rule"
report "$r" 20-data clean "$none_plan"
e=$(evaluate "$r" 10-network 20-data)
expect "every plan clean but a rule opened in the console: drift" '"drift"' "$(field .status "$e")"
expect "the rule is named by id, group and direction" '[{"id":"sgr-0console","group":"sg-0web","egress":false}]' \
  "$(field .unmanaged_rules "$e")"

r="$tmp/other-stack-rule"
report "$r" 10-network clean "$drift_plan" "$with_console_rule"
report "$r" 20-data clean "$none_plan"
echo '{"groups":[],"rules":["sgr-0console"]}' > "$r/drift-unit-20-data/sg-managed.json"
e=$(evaluate "$r" 10-network 20-data)
expect "a rule on a group of one stack, managed by another stack: clean" '"clean"' "$(field .status "$e")"

r="$tmp/failed"
report "$r" 10-network clean "$drift_plan" "$with_console_rule"
report "$r" 20-data failed
e=$(evaluate "$r" 10-network 20-data)
expect "a plan failed and nothing drifted: unknown, never clean" '"unknown"' "$(field .status "$e")"
expect "rules are not judged while a stack is unknown" 'false []' "$(field .rules_checked "$e") $(field .unmanaged_rules "$e")"

r="$tmp/failed-and-drift"
report "$r" 10-network drift "$drift_plan" "$managed_live"
report "$r" 20-data failed
e=$(evaluate "$r" 10-network 20-data)
expect "a plan failed and another drifted: drift" '"drift"' "$(field .status "$e")"

r="$tmp/missing"
report "$r" 10-network clean "$drift_plan" "$managed_live"
e=$(evaluate "$r" 10-network 20-data)
expect "a stack that reported nothing failed: unknown" '"unknown" "failed"' \
  "$(field .status "$e") $(field '.stacks[1].outcome' "$e")"

r="$tmp/odd"
report "$r" 10-network planned "$drift_plan" "$managed_live"
e=$(evaluate "$r" 10-network)
expect "an outcome other than clean or drift counts as failed" '"unknown" "failed"' \
  "$(field .status "$e") $(field '.stacks[0].outcome' "$e")"

echo "deadline:"

expect "reported on a Tuesday: due at the start of Wednesday" 2026-11-18T00:00:00Z "$(bash "$script" deadline 2026-11-17T04:30:00Z)"
expect "reported on a Friday: due at the start of Monday" 2026-11-23T00:00:00Z "$(bash "$script" deadline 2026-11-20T04:30:00Z)"
expect "reported on a Saturday: Monday is the working day, due Tuesday" 2026-11-24T00:00:00Z "$(bash "$script" deadline 2026-11-21T04:30:00Z)"
expect "reported late on a Sunday: the same" 2026-11-24T00:00:00Z "$(bash "$script" deadline 2026-11-22T23:59:59Z)"
expect "across a month and a year" 2027-01-01T00:00:00Z "$(bash "$script" deadline 2026-12-31T04:30:00Z)"
expect "not overdue the same day" false "$(bash "$script" overdue 2026-11-17T04:30:00Z 2026-11-17T23:59:59Z)"
expect "overdue at the deadline" true "$(bash "$script" overdue 2026-11-17T04:30:00Z 2026-11-18T00:00:00Z)"
expect "overdue on the next night's run" true "$(bash "$script" overdue 2026-11-17T04:30:00Z 2026-11-18T04:31:00Z)"
expect "not overdue over the weekend after a Friday report" false "$(bash "$script" overdue 2026-11-20T04:30:00Z 2026-11-22T04:30:00Z)"

echo "body:"

r="$tmp/body"
report "$r" 10-network drift "$drift_plan" "$with_console_rule"
report "$r" 20-data clean "$none_plan"
report "$r" 30-platform failed
evaluate "$r" 10-network 20-data 30-platform > "$tmp/evaluation.json"
body=$(bash "$script" body "$tmp/evaluation.json" "$r" 2026-11-17T04:30:00Z 2026-11-17T04:30:00Z "$run_url")
expect "the first line is the marker the workflow finds the issue by" "<!-- terraform-drift:unit -->" "$(head -n 1 <<<"$body")"
expect "it says when it was first reported and the deadline" \
  "First reported 2026-11-17T04:30:00Z. **Reconcile into Git by 2026-11-18T00:00:00Z.**" \
  "$(grep '^First reported' <<<"$body")"
expect "it links the run and the runbook on this repository" 2 \
  "$(grep -cE "\($run_url\)|\(https://github.com/example-owner/example-repo/blob/main/docs/runbooks/BREAK_GLASS.md\)" <<<"$body")"
# shellcheck disable=SC2016 # the backticks are Markdown, not a command
expect "one row per stack, with the totals of a drifted one" \
  '| `10-network` | **drift**: **1 to add, 2 to change, 0 to replace, 0 to destroy** |
| `20-data` | no drift |
| `30-platform` | **plan failed**, so its drift is unknown; see the run |' \
  "$(grep '^| `' <<<"$body" | grep -v '^| `aws_')"
expect "the rules are not judged while a plan failed" 1 "$(grep -c 'rules outside Terraform: \*\*not checked\*\*' <<<"$body")"
expect "details only for the drifted stack" 1 "$(grep -c '<details>' <<<"$body")"
expect "the details say what changed outside Terraform" 1 "$(grep -c '^\*\*Changed outside Terraform: 2 changed, 1 deleted\*\*$' <<<"$body")"
if grep -qE 'hunter2|console"|3001|10\.0\.0\.0|module\.|web-from-alb|sg/' <<<"$body"; then
  bad "the body carries no value, address or for_each key" "$body"
else
  ok "the body carries no value, address or for_each key"
fi

late=$(bash "$script" body "$tmp/evaluation.json" "$r" 2026-11-17T04:30:00Z 2026-11-18T04:31:00Z "$run_url")
expect "past the deadline it says overdue" \
  "**Overdue.** First reported 2026-11-17T04:30:00Z; it had to be reconciled into Git by 2026-11-18T00:00:00Z." \
  "$(grep '^\*\*Overdue' <<<"$late")"

r="$tmp/body-rule"
report "$r" 10-network clean "$drift_plan" "$with_console_rule"
evaluate "$r" 10-network > "$tmp/evaluation-rule.json"
body=$(bash "$script" body "$tmp/evaluation-rule.json" "$r" 2026-11-17T04:30:00Z 2026-11-17T04:30:00Z "$run_url")
# shellcheck disable=SC2016 # the backticks are Markdown, not a command
expect "a rule outside Terraform is listed by id, group and direction" '- `sgr-0console` on `sg-0web` (ingress)' \
  "$(grep '^- `sgr' <<<"$body")"

echo "errors:"

for args in "" "evaluate unit $tmp/clean" "evaluate ../unit $tmp/clean 10-network" "evaluate unit $tmp/nowhere 10-network" \
  "evaluate unit $tmp/clean network" "deadline" "deadline 2026-11-17" "deadline 2026-11-17T04:30:00+01:00" \
  "deadline 2026-13-45T04:30:00Z" "deadline 2026-02-30T04:30:00Z" "overdue 2026-11-17T04:30:00Z" \
  "body $tmp/evaluation.json $r 2026-11-17T04:30:00Z 2026-11-17T04:30:00Z http://example.com" \
  "body $tmp/evaluation.json $r 2026-11-17T04:30:00Z 2026-11-17T04:30:00Z" "verdict"; do
  # shellcheck disable=SC2086 # the arguments are split on purpose
  out=$(bash "$script" $args 2>&1)
  status=$?
  if [ "$status" = 2 ]; then ok "usage error: ${args:-no arguments}"; else bad "usage error: ${args:-no arguments}" "exit $status: $out"; fi
done
echo '{"not": "an evaluation"}' > "$tmp/not-an-evaluation.json"
out=$(bash "$script" body "$tmp/not-an-evaluation.json" "$r" 2026-11-17T04:30:00Z 2026-11-17T04:30:00Z "$run_url" 2>&1)
expect "a file that is not an evaluation is refused" 1 "$?"

echo
echo "drift-issue.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
