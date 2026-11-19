#!/usr/bin/env bash
# affected.sh — which (environment, stack) pairs a change affects.
#
#   git diff --name-only --no-renames -z <base> <head> | affected.sh [<terraform root>]
#
# Reads the changed paths (repository-relative, NUL-separated) on stdin. The
# environments and stacks are the directories of <terraform root> (default:
# the infra/terraform this script lives in), so the root must be checked out
# at <head>.
#
# Rules:
#   envs/<e>/release.auto.tfvars   (<e>, 35-deploy-tasks), (<e>, 50-agentcore),
#                                  (<e>, 40-services): a release
#   envs/<e>/<anything else>       (<e>, every stack)
#   stacks/<s>/...                 (every environment, <s>)
#   modules/<m>/...                (every environment, every stack that uses
#                                  <m>, directly or through another module)
#   tf.sh, scripts/placeholders.sh (every environment, every stack): they
#                                  decide how every stack is run
#   anything else                  nothing (README, checks, policy fixtures,
#                                  bootstrap/, which a human applies)
# A pair whose environment or stack directory does not exist at <head> is
# left out: it cannot be planned.
#
# stdout: one line per pair, `<env>\t<stack>\t<kind>`, environments sorted,
#         stacks in apply order. <kind> is `release` when only the release
#         file affects the pair, `infra` when only other changes do, `both`
#         otherwise.
# exit:   0, or 1 when a stack directory is missing from the apply order below
#         (a new stack must be placed in it first), 2 on a usage error.
set -euo pipefail

# Part B of docs/roadmap/KOCH_MIGRATION_SPEC.md: 50-agentcore before
# 40-services, which reads what it publishes.
apply_order=(00-foundation 10-network 20-data 30-platform 35-deploy-tasks 50-agentcore 40-services 60-observability)
release_stacks=(35-deploy-tasks 50-agentcore 40-services)

[ "$#" -le 1 ] || { echo "usage: affected.sh [<terraform root>] < changed paths" >&2; exit 2; }
root=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
[ -d "$root/stacks" ] && [ -d "$root/envs" ] || {
  echo "affected.sh: $root has no stacks/ and envs/" >&2
  exit 2
}
prefix=infra/terraform/

envs=()
for dir in "$root"/envs/*/; do
  [ -d "$dir" ] && envs+=("$(basename "$dir")")
done

stacks=()
for stack in "${apply_order[@]}"; do
  [ -d "$root/stacks/$stack" ] && stacks+=("$stack")
done
for dir in "$root"/stacks/*/; do
  [ -d "$dir" ] || continue
  stack=$(basename "$dir")
  if [[ " ${apply_order[*]} " != *" $stack "* ]]; then
    echo "affected.sh: stacks/$stack is not in the apply order; add it to apply_order" >&2
    exit 1
  fi
done

# The stacks that use module $1, directly or through other modules. Only a
# root module's own .tf files count; a module's tests/ do not.
declare -A seen_modules=()
module_users() {
  local module=$1 dir user
  [ -z "${seen_modules[$module]+set}" ] || return 0
  seen_modules[$module]=1
  for stack in "${stacks[@]}"; do
    if grep -qsE "^[[:space:]]*source[[:space:]]*=[[:space:]]*\"\.\./\.\./modules/$module/?\"" "$root/stacks/$stack"/*.tf; then
      echo "$stack"
    fi
  done
  for dir in "$root"/modules/*/; do
    user=$(basename "$dir")
    if grep -qsE "^[[:space:]]*source[[:space:]]*=[[:space:]]*\"\.\./$module/?\"" "$dir"*.tf; then
      module_users "$user"
    fi
  done
}

# kinds["<env> <stack>"] = release | infra | both
declare -A kinds=()
mark() { # env stack kind
  local key="$1 $2" previous
  previous=${kinds[$key]:-}
  if [ -z "$previous" ] || [ "$previous" = "$3" ]; then
    kinds[$key]=$3
  else
    kinds[$key]=both
  fi
}
mark_all_envs() { # stack
  local env_name
  for env_name in "${envs[@]}"; do mark "$env_name" "$1" infra; done
}
mark_all_stacks() { # env
  local stack
  for stack in "${stacks[@]}"; do mark "$1" "$stack" infra; done
}

while IFS= read -r -d '' path; do
  case "$path" in
    "${prefix}"*) path=${path#"$prefix"} ;;
    *) continue ;;
  esac
  case "$path" in
    envs/*/release.auto.tfvars)
      env_name=${path#envs/}
      env_name=${env_name%%/*}
      for stack in "${release_stacks[@]}"; do mark "$env_name" "$stack" release; done
      ;;
    envs/*/*)
      env_name=${path#envs/}
      mark_all_stacks "${env_name%%/*}"
      ;;
    stacks/*/*)
      stack=${path#stacks/}
      mark_all_envs "${stack%%/*}"
      ;;
    modules/*/*)
      module=${path#modules/}
      seen_modules=()
      while IFS= read -r stack; do
        mark_all_envs "$stack"
      done < <(module_users "${module%%/*}")
      ;;
    tf.sh | scripts/placeholders.sh)
      for env_name in "${envs[@]}"; do mark_all_stacks "$env_name"; done
      ;;
  esac
done

for env_name in "${envs[@]}"; do
  for stack in "${stacks[@]}"; do
    kind=${kinds["$env_name $stack"]:-}
    [ -n "$kind" ] && printf '%s\t%s\t%s\n' "$env_name" "$stack" "$kind"
  done
done
exit 0
