#!/usr/bin/env bash
# Fixtures for stateful-replace-allowed.sh. The refusals matter most: a label
# a bot applied, or one the inputs cannot prove a human applied, must not let
# a plan destroy a database.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/stateful-replace-allowed.sh"
pass=0
fail=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Timeline events shaped like GET repos/{repo}/issues/{pr}/timeline.
ev() { # labeled|unlabeled label actor-login actor-type created_at
  jq -cn --arg e "$1" --arg l "$2" --arg a "$3" --arg t "$4" --arg c "$5" \
    '{event: $e, label: {name: $l}, actor: {login: $a, type: $t}, created_at: $c}'
}
L=allow-stateful-replace
human_adds=$(ev labeled $L rob-example User 2026-11-19T10:00:00Z)
bot_adds=$(ev labeled $L "github-actions[bot]" Bot 2026-11-19T11:00:00Z)
app_adds=$(ev labeled $L "review-app[bot]" Bot 2026-11-19T11:00:00Z)
bot_typed_user_adds=$(ev labeled $L "steered-app[bot]" User 2026-11-19T11:00:00Z)
human_removes=$(ev unlabeled $L rob-example User 2026-11-19T10:30:00Z)
other_label=$(ev labeled needs-rob rob-example User 2026-11-19T12:00:00Z)
ghost_adds='{"event":"labeled","label":{"name":"allow-stateful-replace"},"actor":null,"created_at":"2026-11-19T11:00:00Z"}'
on='[{"name":"needs-rob"},{"name":"allow-stateful-replace"}]'

check() { # name expected(true|false) labels-json timeline-json
  printf '%s' "$3" > "$tmp/labels.json"
  printf '%s' "$4" > "$tmp/timeline.json"
  local out got
  out=$(bash "$script" "$tmp/labels.json" "$tmp/timeline.json" 2>&1)
  got=$(tail -n 1 <<<"$out")
  if [ "$got" = "allowed=$2" ]; then
    echo "  ok   $1"
    pass=$((pass + 1))
  else
    echo "  FAIL $1 (want allowed=$2, got '$got')"
    printf '%s\n' "$out" | sed 's/^/       /'
    fail=$((fail + 1))
  fi
}

echo "allow-stateful-replace:"

check "applied by a human and on the pull request" true "$on" "[$human_adds,$other_label]"
check "paginated input (--paginate --slurp)" true "[$on]" "[[$human_adds],[$other_label]]"
check "re-applied by a human after a removal" true "$on" \
  "[$(ev labeled $L rob-example User 2026-11-19T09:00:00Z),$human_removes,$human_adds]"

check "not on the pull request" false '[{"name":"needs-rob"}]' "[$human_adds]"
check "removed again after a human applied it" false '[]' "[$human_adds,$human_removes]"
check "applied by github-actions[bot]" false "$on" "[$bot_adds]"
check "applied by a GitHub App" false "$on" "[$app_adds]"
check "applied by a [bot] login typed as User" false "$on" "[$bot_typed_user_adds]"
check "applied by a human, then again by a bot (the last application counts)" false "$on" "[$human_adds,$bot_adds]"
check "applied with no actor" false "$on" "[$ghost_adds]"
check "on the pull request but no event applied it" false "$on" "[$other_label]"
check "unreadable labels" false 'not json' "[$human_adds]"
check "unreadable timeline" false "$on" '{"message":"Not Found"}'

out=$(bash "$script" "$tmp/labels.json" 2>&1)
if [ "$(tail -n 1 <<<"$out")" = "allowed=false" ]; then
  echo "  ok   a usage error refuses"
  pass=$((pass + 1))
else
  echo "  FAIL a usage error refuses"
  fail=$((fail + 1))
fi

echo
echo "stateful-replace-allowed.sh: $pass passed, $fail failed"
[ "$fail" = 0 ]
