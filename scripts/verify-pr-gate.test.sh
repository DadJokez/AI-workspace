#!/usr/bin/env bash
# Exercise the audit engine with GitHub-shaped responses; never call GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export REVIEW_FILE="$tmp/review"
export GH_REPO=fixture/repo
export PATH="$tmp:$PATH"
cat > "$tmp/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$2" in
  */actions/runs\?*) echo 1 ;;
  */commits/*/status)
    if [[ "$4" == *'Claude verdict'* ]]; then echo success; else echo ''; fi ;;
  */labels) printf '%s\n' "${LABELS_JSON:-[[]]}" ;;
  */timeline) printf '%s\n' "${TIMELINE_JSON:-[[]]}" ;;
  */reviews)
    jq -n --rawfile body "$REVIEW_FILE" \
      '[[{user: {login: "github-actions[bot]"}, submitted_at: "1", body: $body}]]' ;;
  */check-runs\?*) echo '{"check_runs":[]}' ;;
  *) echo "Unexpected gh call: $*" >&2; exit 2 ;;
esac
MOCK
chmod +x "$tmp/gh"
pass=0
check() {
  local name="$1" expected="$2" output status=0
  printf '%s\n' "$3" > "$REVIEW_FILE"
  output=$(bash scripts/verify-pr-gate.sh 1 fixture-sha 2>&1) || status=$?
  if [ "$status" != "$expected" ]; then
    printf 'FAIL %s: expected exit %s, got %s\n%s\n' "$name" "$expected" "$status" "$output"
    exit 1
  fi
  printf 'ok %s\n' "$name"
  pass=$((pass + 1))
}

# Actual first lines from the reviews that caused incidents #914 and #916.
check '#913 clean review' 0 '**Clean — no blocking issue, no `needs-rob`.** This is prompt copy + an eval fixture change: no auth/permissions/secret/env/IAM/OIDC surface, no DB migration, no new production dependency, no gate loosened, so nothing here is human-owned under §7.'
check '#915 clean review' 0 '**Reviewed — clean, no blocker. Not human-owned under CLAUDE.md §7:** this is evals-only (judge rubrics + judge/harness plumbing + a dev replay script and pinned controls). No product code, no new dependency, no DB migration, no auth/permissions/secret/env/IAM/OIDC surface, and no gate is loosened. `needs-rob` does not apply.'
# Actual #885 ruling and its sign-off refusal must remain blocking.
check '#885 human-owned review' 1 "**Review — clean change, but this one stays Rob's to sign off (§7).**"
check '#885 sign-off refusal' 1 'Review of the action pins.
So I am not posting the §7 sign-off; this needs Rob’s explicit go.'

check 'Markdown emphasis inside negation' 0 '**Not** **human-owned under** §7.'
check 'is not' 0 'This is not human-owned under §7.'
check 'nothing is' 0 'Nothing is human-owned under §7.'
check 'contraction' 0 "This isn't human-owned under §7."
check 'no longer' 0 'This is no longer human-owned under §7.'
check 'space spelling' 0 'NOT HUMAN OWNED UNDER §7.'
check 'plain clean' 0 'Clean; no §7 surface.'
check 'positive ownership' 1 'This is human-owned under §7.'
check 'emphasized positive ownership' 1 'This is **human-owned under** §7.'
check 'positive hold' 1 '`needs-rob` applied before review.'
check 'negation plus separate positive ownership' 1 'The tests are not human-owned under §7; the IAM change is human-owned under §7.'
check 'negation plus separate hold' 1 'Not human-owned under the migration rule; needs-rob applies for auth.'
check 'not only is not a negation' 1 'Not only human-owned under §7, but also untested.'
check 'negation cannot swallow punctuation' 1 'Not clean. Human-owned under §7.'
check 'negation cannot swallow a full-body refusal' 1 'Not human-owned under the migration rule.
This is not clear-to-merge.'
check 'mention on a later line is not a ruling' 0 'Clean; no §7 surface.
The parser detects human-owned under §7 in genuine blocking reviews.'

export LABELS_JSON='[[{"name":"needs-rob"}]]'
check 'clean text cannot bypass a hold label' 1 'Not human-owned under §7.'
export LABELS_JSON='[[]]'
export TIMELINE_JSON='[[{"event":"labeled","label":{"name":"needs-rob"},"actor":{"login":"DadJokez","type":"User"},"created_at":"1"},{"event":"unlabeled","label":{"name":"needs-rob"},"actor":{"login":"github-actions[bot]","type":"Bot"},"created_at":"2"}]]'
check 'clean text cannot bypass a bot-removed hold' 1 'Not human-owned under §7.'
export TIMELINE_JSON='[[{"event":"labeled","label":{"name":"needs-rob"},"actor":{"login":"DadJokez","type":"User"},"created_at":"1"},{"event":"unlabeled","label":{"name":"needs-rob"},"actor":{"login":"DadJokez","type":"User"},"created_at":"2"}]]'
check 'human release still overrides a positive review' 0 'Human-owned under §7.'
printf '%s passed\n' "$pass"
