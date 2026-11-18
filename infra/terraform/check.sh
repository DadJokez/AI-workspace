#!/usr/bin/env bash
# Static checks for infra/terraform. No cloud credentials, no state, no AWS
# calls. CI runs each step as its own job step; a human runs them all with
#
#   infra/terraform/check.sh            # every step
#   infra/terraform/check.sh policy     # one step
#
# Steps: fmt, versions, validate, lint, test, policy.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$root"

step_fmt() {
  terraform fmt -check -recursive -diff
}

# Every stack's versions.tf is a byte-for-byte copy of versions.tf.tmpl.
step_versions() {
  local status=0 file
  for file in stacks/*/versions.tf; do
    if ! cmp -s versions.tf.tmpl "$file"; then
      echo "versions: $file differs from versions.tf.tmpl" >&2
      status=1
    fi
  done
  for file in stacks/*/; do
    if [ ! -f "${file}versions.tf" ]; then
      echo "versions: ${file} has no versions.tf" >&2
      status=1
    fi
  done
  return "$status"
}

# Root modules: the committed lock file must already cover them.
step_validate() {
  local dir
  for dir in stacks/*/ bootstrap/; do
    echo "== validate ${dir%/}"
    terraform -chdir="$dir" init -backend=false -input=false -lockfile=readonly >/dev/null
    terraform -chdir="$dir" validate
  done
}

step_lint() {
  tflint --recursive --config="$root/.tflint.hcl"
}

step_test() {
  local dir
  for dir in modules/*/; do
    echo "== test ${dir%/}"
    terraform -chdir="$dir" init -backend=false -input=false >/dev/null
    terraform -chdir="$dir" test
  done
}

# Each rule has a directory policy/fixtures/<rule id>/ with:
#   pass.json          a plan that every rule accepts
#   fail.json          a plan this rule rejects
#   fail.expected.txt  the exact messages fail.json must produce, sorted
# A failing fixture must fail with exactly those messages, each starting with
# "[<rule id>]": that proves it fails for the stated reason and no other.
step_policy() {
  local status=0 dir rule actual
  for dir in policy/fixtures/*/; do
    rule=$(basename "$dir")

    if ! conftest test --policy policy --no-color "${dir}pass.json" >/dev/null; then
      echo "policy: ${dir}pass.json was rejected:" >&2
      conftest test --policy policy --no-color "${dir}pass.json" >&2 || true
      status=1
    fi

    actual=$(conftest test --policy policy --no-color --output json "${dir}fail.json" |
      jq -r '.[].failures[]?.msg' | LC_ALL=C sort || true)
    if [ -z "$actual" ]; then
      echo "policy: ${dir}fail.json was accepted, expected it to be rejected" >&2
      status=1
    elif grep -qv "^\[$rule\] " <<<"$actual"; then
      echo "policy: ${dir}fail.json fails for a reason other than [$rule]:" >&2
      echo "$actual" >&2
      status=1
    elif ! diff -u "${dir}fail.expected.txt" <(echo "$actual") >&2; then
      echo "policy: ${dir}fail.json does not fail with the messages in fail.expected.txt" >&2
      status=1
    else
      echo "ok  $rule: pass.json accepted, fail.json rejected with $(wc -l <<<"$actual" | tr -d ' ') [$rule] message(s)"
    fi
  done

  # A rule without fixtures is a rule nobody proved.
  local id
  for id in $(grep -ho 'sprintf("\[[a-z0-9-]*\]' policy/*.rego | sed 's/.*\[\(.*\)\]/\1/' | sort -u); do
    if [ ! -f "policy/fixtures/$id/pass.json" ] || [ ! -f "policy/fixtures/$id/fail.json" ]; then
      echo "policy: rule [$id] has no pass.json and fail.json under policy/fixtures/$id/" >&2
      status=1
    fi
  done
  return "$status"
}

steps=(fmt versions validate lint test policy)
if [ "$#" -gt 0 ]; then
  steps=("$@")
fi

for step in "${steps[@]}"; do
  case "$step" in
    fmt | versions | validate | lint | test | policy)
      echo "### $step"
      "step_$step"
      ;;
    *)
      echo "check.sh: unknown step '$step' (fmt, versions, validate, lint, test, policy)" >&2
      exit 2
      ;;
  esac
done
