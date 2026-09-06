#!/usr/bin/env bash
# Fixture matrix for the sticky `needs-rob` hold (#891).
#
# The fail-CLOSED direction matters most: a hold that a bot stripped, or that
# the inputs cannot prove released, must still read as present. The absent
# cases exist so a PR Rob actually released (or never held) can merge.
set -uo pipefail
cd "$(dirname "$0")/../.."
pass=0
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Timeline event fixtures, shaped like GET repos/{repo}/issues/{pr}/timeline.
ev() { # labeled|unlabeled label actor-login actor-type created_at
  jq -cn --arg e "$1" --arg l "$2" --arg a "$3" --arg t "$4" --arg c "$5" \
    '{event: $e, label: {name: $l, color: "B60205"},
      actor: {login: $a, type: $t}, created_at: $c}'
}
rob_adds=$(ev labeled needs-rob DadJokez User 2026-09-04T15:13:14Z)
rob_removes=$(ev unlabeled needs-rob DadJokez User 2026-09-05T09:00:00Z)
bot_removes=$(ev unlabeled needs-rob "github-actions[bot]" Bot 2026-09-05T09:00:00Z)
app_removes=$(ev unlabeled needs-rob "claude[bot]" Bot 2026-09-05T09:00:00Z)
codex_adds=$(ev labeled needs-codex "github-actions[bot]" Bot 2026-09-04T16:00:00Z)
codex_removed_by_bot=$(ev unlabeled needs-codex "github-actions[bot]" Bot 2026-09-04T17:00:00Z)
ghost_removes='{"event":"unlabeled","label":{"name":"needs-rob"},"actor":null,"created_at":"2026-09-05T09:00:00Z"}'
bot_typed_user=$(ev unlabeled needs-rob "steered-app[bot]" User 2026-09-05T09:00:00Z)

check() { # name expected(present|absent) expected-reason labels-json timeline-json
  local name="$1" want="$2" want_reason="$3"
  printf '%s' "$4" > "$tmp/labels.json"
  printf '%s' "$5" > "$tmp/timeline.json"
  local out got got_reason
  out="$(bash .github/scripts/needs-rob-gate.sh "$tmp/labels.json" "$tmp/timeline.json" 2>&1)"
  got="$(printf '%s\n' "$out" | tail -n 1)"
  got_reason="$(printf '%s\n' "$out" | tail -n 2 | head -n 1)"
  if [ "$got" = "needs_rob=$want" ] && [ "$got_reason" = "reason=$want_reason" ]; then
    echo "  ok   $name"
    pass=$((pass + 1))
  else
    echo "  FAIL $name (want needs_rob=$want reason=$want_reason, got '$got' '$got_reason')"
    printf '%s\n' "$out" | sed 's/^/       /'
    fail=$((fail + 1))
  fi
}

echo "needs-rob hold:"

# --- present: the hold blocks the verdict ---
check "label on the PR" present label-present \
  '[{"name":"needs-rob","color":"B60205"}]' "[$rob_adds]"
check "label on the PR alongside needs-codex" present label-present \
  '[{"name":"needs-codex"},{"name":"needs-rob"}]' "[$rob_adds,$codex_adds]"
check "label on the PR, empty timeline (labels win)" present label-present \
  '[{"name":"needs-rob"}]' '[]'
check "removed by github-actions[bot] (steered review lane)" present bot-removed \
  '[]' "[$rob_adds,$bot_removes]"
check "removed by a GitHub App bot" present bot-removed \
  '[]' "[$rob_adds,$app_removes]"
check "removed by a [bot] login typed as User" present bot-removed \
  '[]' "[$rob_adds,$bot_typed_user]"
check "removed with no actor (ghost)" present bot-removed \
  '[]' "[$rob_adds,$ghost_removes]"
check "bot removal after an earlier human removal (latest wins)" present bot-removed \
  '[]' "[$rob_adds,$rob_removes,$(ev labeled needs-rob DadJokez User 2026-09-05T10:00:00Z),$(ev unlabeled needs-rob "github-actions[bot]" Bot 2026-09-05T11:00:00Z)]"
check "bot removal later by time but earlier in array order" present bot-removed \
  '[]' "[$(ev unlabeled needs-rob "github-actions[bot]" Bot 2026-09-05T11:00:00Z),$rob_adds,$rob_removes]"
check "off the PR but last event is labeled (repo-wide label deletion)" present applied-but-missing \
  '[]' "[$rob_adds]"
check "off the PR, last event labeled, other labels present" present applied-but-missing \
  '[{"name":"needs-codex"}]' "[$codex_adds,$rob_adds]"
check "paginated (--slurp) inputs" present bot-removed \
  "[[{\"name\":\"ops\"}],[]]" "[[$rob_adds],[$bot_removes]]"
check "unreadable labels JSON" present invalid-input \
  'not json' "[$rob_adds]"
check "unreadable timeline JSON" present invalid-input \
  '[]' '{"message":"Not Found"}'
check "labels JSON is an object, not an array" present invalid-input \
  '{"message":"Bad credentials"}' '[]'

# --- absent: nothing to hold ---
check "never applied, empty timeline" absent never-applied '[]' '[]'
check "never applied, only needs-codex events" absent never-applied \
  '[{"name":"needs-codex"}]' "[$codex_adds,$codex_removed_by_bot]"
check "never applied, unrelated timeline events" absent never-applied \
  '[]' '[{"event":"commented","actor":{"login":"DadJokez","type":"User"}},{"event":"reviewed"}]'
check "removed by Rob (human)" absent human-removed \
  '[]' "[$rob_adds,$rob_removes]"
check "removed by Rob after a bot removal and re-add (latest wins)" absent human-removed \
  '[]' "[$rob_adds,$bot_removes,$(ev labeled needs-rob DadJokez User 2026-09-05T10:00:00Z),$(ev unlabeled needs-rob DadJokez User 2026-09-05T11:00:00Z)]"
check "needs-codex bot-removed does not stick to needs-rob" absent human-removed \
  '[]' "[$rob_adds,$rob_removes,$codex_adds,$codex_removed_by_bot]"

# --- argument errors fail closed ---
out="$(bash .github/scripts/needs-rob-gate.sh 2>&1)"
if [ "$(printf '%s\n' "$out" | tail -n 1)" = "needs_rob=present" ]; then
  echo "  ok   no arguments"
  pass=$((pass + 1))
else
  echo "  FAIL no arguments (got '$out')"
  fail=$((fail + 1))
fi
out="$(bash .github/scripts/needs-rob-gate.sh "$tmp/does-not-exist.json" "$tmp/labels.json" 2>&1)"
if [ "$(printf '%s\n' "$out" | tail -n 1)" = "needs_rob=present" ]; then
  echo "  ok   missing input file"
  pass=$((pass + 1))
else
  echo "  FAIL missing input file (got '$out')"
  fail=$((fail + 1))
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" = "0" ]
