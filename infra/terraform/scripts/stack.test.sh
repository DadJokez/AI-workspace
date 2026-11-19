#!/usr/bin/env bash
# Fixtures for stack.sh: what the apply workflow applies, and what it
# refuses. The refusals matter most: a plan that differs from the reviewed
# one, a stateful replacement nobody allowed, a plan a policy rule rejects,
# and pending changes to a stack only a human may apply.
#
# Runs against a copy of tf.sh and the scripts in a throwaway tree, with a
# stand-in `terraform` (its plan is a fixture of plan-report.sh) and a
# stand-in `conftest`. No credentials, no state, no AWS calls.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
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

root="$tmp/infra/terraform"
mkdir -p "$root/scripts" "$root/policy" "$root/envs/unit" "$root/stacks/40-services" "$tmp/bin"
cp "$here/../tf.sh" "$root/"
cp "$here/stack.sh" "$here/plan-report.sh" "$here/placeholders.sh" "$root/scripts/"
printf 'bucket = "state"\n' > "$root/envs/unit/backend.hcl"
printf 'env = "unit"\n' > "$root/envs/unit/env.tfvars"
printf 'release_id = "x"\n' > "$root/envs/unit/release.auto.tfvars"
script="$root/scripts/stack.sh"

mixed="$here/fixtures/plan-report/mixed.json"
none="$here/fixtures/plan-report/no-changes.json"
jq '.resource_changes |= map(select(.type != "aws_db_instance" and .type != "aws_s3_bucket" and .type != "aws_ecr_repository"))' \
  "$mixed" > "$tmp/stateless.json"

# terraform: `plan -out=F` writes the path of $FAKE_PLAN into F, `show -json F`
# prints that plan, `apply F` records it. Every call is logged.
cat > "$tmp/bin/terraform" <<'EOF'
#!/usr/bin/env bash
echo "terraform $*" >> "$FAKE_LOG"
chdir=$1
shift
case "$1" in
  init) exit 0 ;;
  plan)
    for arg in "$@"; do
      case "$arg" in -out=*) echo "$FAKE_PLAN" > "${arg#-out=}" ;; esac
    done
    exit "${FAKE_PLAN_EXIT:-0}"
    ;;
  show) cat "$(cat "${@: -1}")" ;;
  apply) exit "${FAKE_APPLY_EXIT:-0}" ;;
  *) echo "unexpected terraform $*" >&2; exit 99 ;;
esac
EOF
cat > "$tmp/bin/conftest" <<'EOF'
#!/usr/bin/env bash
echo "conftest $*" >> "$FAKE_LOG"
if [ -n "${FAKE_POLICY_FAILURE:-}" ]; then
  jq -n --arg m "$FAKE_POLICY_FAILURE" '[{filename: "plan.json", failures: [{msg: $m}]}]'
  exit 1
fi
echo '[{"filename": "plan.json", "successes": 8}]'
EOF
chmod +x "$tmp/bin/terraform" "$tmp/bin/conftest"

n=0
# run <plan fixture> <stack.sh args...>; sets $status, $output, $log and
# $outdir (the out dir argument)
run() {
  n=$((n + 1))
  log="$tmp/log$n"
  : > "$log"
  local plan=$1
  shift
  outdir=${4:-}
  output=$(env PATH="$tmp/bin:$PATH" FAKE_LOG="$log" FAKE_PLAN="$plan" bash "$script" "$@" 2>&1)
  status=$?
}
report() { jq -r "$1" "$outdir/report.json" 2>/dev/null; }
reviewed() { # plan fixture -> a reviewed report of that plan
  jq -n --arg f "$(bash "$here/plan-report.sh" fingerprint "$1")" '{fingerprint: $f}' > "$tmp/reviewed.json"
  echo "$tmp/reviewed.json"
}
expect() { # name condition-command...
  local name=$1
  shift
  if "$@"; then ok "$name"; else bad "$name" "exit $status
$output
log:
$(cat "$log" 2>/dev/null)"; fi
}
applied() { grep -q "apply -input=false $outdir/plan.tfplan" "$log"; }
not_applied() { ! grep -q ' apply ' "$log"; }

echo "plan:"

run "$mixed" plan unit 40-services "$tmp/plan-out"
expect "a plan writes its report and passes" test "$status" = 0
expect "the report counts the changes and names the stateful ones" test \
  "$(report '[.changes, (.stateful | length), .policy_ok, .applied] | @tsv')" = "$(printf '11\t3\ttrue\tfalse')"
expect "the report carries the fingerprint of plan-report.sh" test \
  "$(report .fingerprint)" = "$(bash "$here/plan-report.sh" fingerprint "$mixed")"
# shellcheck disable=SC2016 # the backticks are Markdown, not a command
expect "the summary is written for the comment" grep -q '^| `aws_ecs_service` | 0 | 2 |' "$outdir/summary.md"
expect "the pull-request plan takes no state lock and passes both variable files" \
  grep -q "plan -var-file=$root/envs/unit/env.tfvars -var-file=$root/envs/unit/release.auto.tfvars -input=false -lock=false -out=$outdir/plan.tfplan" "$log"
expect "the pull-request plan never applies" not_applied

FAKE_POLICY_FAILURE="[required-tags] aws_iam_role.extra is missing tags: owner" run "$mixed" plan unit 40-services "$tmp/plan-policy"
expect "a policy failure is reported, not hidden" test \
  "$(report '[.policy_ok, .policy_failures[0]] | @tsv')" = "$(printf 'false\t[required-tags] aws_iam_role.extra is missing tags: owner')"

FAKE_PLAN_EXIT=1 run "$mixed" plan unit 40-services "$tmp/plan-error"
expect "a failed plan fails" test "$status" != 0

echo "check:"

run "$none" check unit 40-services "$tmp/check-none"
expect "a human-applied stack with nothing pending passes" test "$status" = 0
expect "the check takes no state lock" grep -q -- "-lock=false" "$log"
run "$tmp/stateless.json" check unit 40-services "$tmp/check-pending"
expect "a human-applied stack with pending changes fails and says why" \
  test "$status" = 1 -a -n "$(grep 'a human applies this stack' <<<"$output")"
expect "the check never applies" not_applied

echo "drift:"

drift_fixture="$here/fixtures/plan-report/drift.json"
run "$none" drift unit 40-services "$tmp/drift-none"
expect "no changes (exit 0): passes and reports no drift" test "$status" = 0 -a "$(report .drift)" = false
expect "the drift plan asks for the detailed exit code and takes no state lock" \
  grep -q -- "-input=false -lock=false -detailed-exitcode -out=$outdir/plan.tfplan" "$log"
expect "nothing changed outside Terraform is written for the issue" \
  test "$(cat "$outdir/outside.md")" = "Nothing changed outside Terraform."
FAKE_PLAN_EXIT=2 run "$drift_fixture" drift unit 40-services "$tmp/drift-found"
expect "changes (exit 2): passes and reports drift" test "$status" = 0 -a "$(report .drift)" = true
expect "the report still counts the changes" test "$(report .changes)" = 3
expect "what changed outside Terraform is written for the issue" \
  grep -q '^\*\*Changed outside Terraform: 2 changed, 1 deleted\*\*$' "$outdir/outside.md"
expect "the drift plan never applies" not_applied
FAKE_PLAN_EXIT=1 run "$none" drift unit 40-services "$tmp/drift-error"
expect "a failed plan (exit 1) fails and is not read as drift" \
  test "$status" = 1 -a -n "$(grep 'the plan failed (exit 1)' <<<"$output")"
expect "a failed plan writes no report" test ! -f "$outdir/report.json"
run "$none" drift unit 90-missing "$tmp/drift-missing"
expect "an unknown stack fails before Terraform, so tf.sh's exit 2 is never read as drift" \
  test "$status" = 1 -a ! -s "$log"
printf 'account_id = "REPLACE_ME_ACCOUNT_ID"\n' >> "$root/envs/unit/env.tfvars"
FAKE_PLAN_EXIT=2 run "$drift_fixture" drift unit 40-services "$tmp/drift-placeholder"
expect "an environment with placeholders fails before Terraform" \
  test "$status" = 1 -a ! -s "$log" -a -n "$(grep 'placeholder values' <<<"$output")"
sed -i '/REPLACE_ME/d' "$root/envs/unit/env.tfvars"

echo "apply:"

run "$none" apply unit 40-services "$tmp/apply-none"
expect "nothing to apply: passes without applying" test "$status" = 0
expect "nothing to apply: no apply" not_applied

run "$tmp/stateless.json" apply unit 40-services "$tmp/apply-release"
expect "a release plan without a reviewed plan is applied" test "$status" = 0
expect "it applies the saved plan, with the state lock and no variable file" applied
expect "the apply plan takes the state lock" bash -c "! grep -q -- -lock=false '$log'"
expect "the saved plan is applied without -var-file" bash -c "! grep ' apply ' '$log' | grep -q var-file"
expect "the report says it was applied" test "$(report .applied)" = true

run "$tmp/stateless.json" apply unit 40-services "$tmp/apply-match" "$(reviewed "$tmp/stateless.json")"
expect "a plan equal to the reviewed one is applied" applied

ALLOW_STATEFUL_REPLACE=true run "$tmp/stateless.json" apply unit 40-services "$tmp/apply-differs" "$(reviewed "$mixed")"
expect "a plan that differs from the reviewed one is refused" \
  test "$status" = 1 -a -n "$(grep 'differs from the one reviewed' <<<"$output")"
expect "a differing plan is not applied" not_applied

run "$mixed" apply unit 40-services "$tmp/apply-stateful"
expect "a stateful replacement without a reviewed plan is refused" \
  test "$status" = 1 -a -n "$(grep 'allow-stateful-replace: module.data.aws_db_instance.this' <<<"$output")"
expect "the stateful replacement is not applied" not_applied

run "$mixed" apply unit 40-services "$tmp/apply-stateful-denied" "$(reviewed "$mixed")"
expect "a reviewed stateful replacement without the label is refused" test "$status" = 1
expect "it is not applied" not_applied

ALLOW_STATEFUL_REPLACE=true run "$mixed" apply unit 40-services "$tmp/apply-stateful-label-only"
expect "the label alone, without a reviewed plan, does not allow it" test "$status" = 1
expect "it is not applied" not_applied

ALLOW_STATEFUL_REPLACE=true run "$mixed" apply unit 40-services "$tmp/apply-stateful-allowed" "$(reviewed "$mixed")"
expect "a reviewed stateful replacement with the label is applied" applied

FAKE_POLICY_FAILURE="[ecs-no-public-ip] module.web.aws_ecs_service.this sets assign_public_ip = true" \
  run "$tmp/stateless.json" apply unit 40-services "$tmp/apply-policy" "$(reviewed "$tmp/stateless.json")"
expect "a plan a policy rule rejects is refused, reviewed or not" \
  test "$status" = 1 -a -n "$(grep 'ecs-no-public-ip' <<<"$output")"
expect "it is not applied" not_applied

FAKE_APPLY_EXIT=1 run "$tmp/stateless.json" apply unit 40-services "$tmp/apply-fails"
expect "a failed apply fails" test "$status" != 0
expect "a failed apply is not reported as applied" test "$(report .applied)" = false

echo "refused before Terraform:"

printf 'account_id = "REPLACE_ME_ACCOUNT_ID"\n' >> "$root/envs/unit/env.tfvars"
run "$tmp/stateless.json" apply unit 40-services "$tmp/apply-placeholder"
expect "an environment with placeholders is refused by tf.sh" \
  test "$status" != 0 -a -n "$(grep 'placeholder values' <<<"$output")"
expect "nothing is planned for it" bash -c "! grep -q ' plan ' '$log'"
sed -i '/REPLACE_ME/d' "$root/envs/unit/env.tfvars"

for args in "deploy unit 40-services $tmp/x" "plan unit 40-services" "plan ../unit 40-services $tmp/x" \
  "plan unit services $tmp/x" "check unit 40-services $tmp/x extra" "drift unit 40-services $tmp/x extra" \
  "apply unit 40-services $tmp/x $tmp/missing.json"; do
  # shellcheck disable=SC2086 # the arguments are split on purpose
  run "$none" $args
  expect "usage error: $args" test "$status" = 2 -a ! -s "$log"
done

echo
echo "stack.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
