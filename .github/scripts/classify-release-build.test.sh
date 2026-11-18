#!/usr/bin/env bash
# Fixture matrix for classify-release-build.sh.
#
# The direction that must never fail: a push that changes what an image
# contains always builds. The two skip cases exist so that merging a release
# pull request does not start the next build, and a documentation merge does
# not cut a release.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
pass=0
fail=0

check() { # name expected(true|false) paths...
  local name="$1" want="$2"
  shift 2
  local out got
  if (($# == 0)); then
    out="$(bash .github/scripts/classify-release-build.sh </dev/null 2>&1)"
  else
    out="$(printf '%s\0' "$@" | bash .github/scripts/classify-release-build.sh 2>&1)"
  fi
  got="$(printf '%s\n' "$out" | tail -n 1)"
  if [ "$got" = "build=$want" ]; then
    echo "  ok   $name"
    pass=$((pass + 1))
  else
    echo "  FAIL $name (want build=$want, got '$got')"
    printf '%s\n' "$out" | sed 's/^/       /'
    fail=$((fail + 1))
  fi
}

echo "release build classification:"

# --- nothing to build ---
check "release bump of one environment" false \
  infra/terraform/envs/personal-stage/release.auto.tfvars
check "release bump of two environments" false \
  infra/terraform/envs/personal-stage/release.auto.tfvars \
  infra/terraform/envs/personal-prod/release.auto.tfvars
check "documentation only" false docs/BUILD_QUEUE.md README.md
check "release bump beside documentation" false \
  infra/terraform/envs/personal-stage/release.auto.tfvars docs/ROADMAP.md

# --- builds ---
check "application code" true apps/web/app/page.tsx
check "release bump beside application code" true \
  infra/terraform/envs/personal-stage/release.auto.tfvars apps/web/app/page.tsx
check "a Dockerfile" true apps/web/Dockerfile
check "the lockfile" true pnpm-lock.yaml
check "the environment's other variable file" true \
  infra/terraform/envs/personal-stage/env.tfvars
check "a release file outside envs/<env>/" true \
  infra/terraform/release.auto.tfvars
check "a release file nested below an environment" true \
  infra/terraform/envs/personal-stage/old/release.auto.tfvars
check "a look-alike name" true \
  infra/terraform/envs/personal-stage/release.auto.tfvars.bak
check "instruction file under docs/" true docs/CLAUDE.md
check "this workflow" true .github/workflows/build-release.yml
check "no paths at all" true

echo
echo "$pass passed, $fail failed"
[ "$fail" = "0" ]
