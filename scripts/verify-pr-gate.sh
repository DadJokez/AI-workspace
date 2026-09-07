#!/usr/bin/env bash
# verify-pr-gate.sh <pr-number> [expected-head-sha]
#
# Post-merge audit engine for .github/workflows/merge-gate-audit.yml — NOT a
# merge path. Merging is plain `gh pr merge --squash --delete-branch` once
# checks are green; server-side branch protection (required checks, strict,
# enforce_admins) is what actually gates the merge. This script re-verifies,
# after the fact, that a PR's head SHA had
#   1. a successful "CI" and "Product Smoke" workflow run AT that SHA,
#   2. a success "Claude verdict" commit status (the AI review of that SHA),
#      and no `needs-rob` / `needs-codex` hold on the PR (#891),
#   3. no check-run or status context in a red or unfinished state.
# Absence of a gate is failure — a merge that outran the workflows must not
# pass just because nothing red exists yet. It exists because protection can
# silently vanish (the #479 root cause was a paid-plan lapse dropping it);
# the audit workflow catches that class. Also fine to run manually when
# reviewing a suspect merge.
set -euo pipefail

pr="${1:?usage: verify-pr-gate.sh <pr-number> [expected-head-sha]}"
repo="${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
sha="${2:-$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)}"
fail=0

echo "verify-pr-gate: PR #$pr @ $sha in $repo"

# 1) Required workflows each have a successful run at exactly this SHA.
for wf in "CI" "Product Smoke"; do
  ok=$(gh api "repos/$repo/actions/runs?head_sha=$sha&per_page=100" \
    --jq "[.workflow_runs[] | select(.name==\"$wf\" and .conclusion==\"success\")] | length")
  if [ "${ok:-0}" = "0" ]; then
    echo "FAIL: required workflow '$wf' has no successful run at $sha"
    fail=1
  fi
done

# 2) The AI review verdict for this exact SHA is success.
verdict=$(gh api "repos/$repo/commits/$sha/status" \
  --jq '[.statuses[] | select(.context=="Claude verdict")][0].state // "absent"')
if [ "$verdict" != "success" ]; then
  echo "FAIL: 'Claude verdict' status is '$verdict' at $sha"
  fail=1
fi

# 2b) No hold label on the PR (#891). `needs-rob` is sticky — a bot removal
#     does not release it (see .github/scripts/needs-rob-gate.sh) — and
#     `needs-codex` means Claude still wants changes. Belt and braces: the
#     verdict above is already red while either is present.
gate="$(dirname "$0")/../.github/scripts/needs-rob-gate.sh"
labels_file=$(mktemp)
timeline_file=$(mktemp)
trap 'rm -f "$labels_file" "$timeline_file"' EXIT
gh api "repos/$repo/issues/$pr/labels" --paginate --slurp > "$labels_file"
gh api "repos/$repo/issues/$pr/timeline" --paginate --slurp > "$timeline_file"
hold=$(bash "$gate" "$labels_file" "$timeline_file")
echo "needs-rob: $(head -n 1 <<<"$hold")"
if [ "$(tail -n 1 <<<"$hold")" = "needs_rob=present" ]; then
  echo "FAIL: needs-rob hold is present on PR #$pr — only Rob removes it"
  fail=1
fi
if jq -e 'flatten(1) | any(.name == "needs-codex")' "$labels_file" >/dev/null; then
  echo "FAIL: needs-codex is present on PR #$pr"
  fail=1
fi

# 2c) The #885 shape: the latest automated review ruled the change Rob's but
#     the label never landed. Judged only while no human has released a hold —
#     once Rob removes `needs-rob`, Rob has decided, whatever the review said.
#     Bare "§7" is deliberately not matched: a delegated §7 sign-off cites it.
if grep -qx 'reason=never-applied' <<<"$hold"; then
  latest_review=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate --slurp \
    | jq -r '[.[][] | select(.user.login == "github-actions[bot]")]
             | sort_by(.submitted_at) | last | .body // ""')
  #     A review that merely *mentions* the label (any review of the gate
  #     machinery does) is not a ruling: the ruling phrase is read from the
  #     review's first line, where the reviewer is instructed to put it.
  review_first_line=$(head -n 1 <<<"$latest_review")
  # Ignore a negated ownership phrase, not the whole line: a separate positive
  # ruling must still block. Strip Markdown emphasis before matching (#928).
  review_first_line=$(printf '%s\n' "$review_first_line" | tr '[:upper:]' '[:lower:]' \
    | sed -E "s/[*\`]+//g; s/(^|[^[:alnum:]_])(not|nothing( here)? is|isn't|no longer)[[:space:]]+human[ -]owned under/\1/g")
  if grep -qiE "needs[ -]rob (applied|applies|hold)|human[ -]owned under" <<<"$review_first_line" \
     || grep -qiE "not clear[ -]to[ -]merge|stays rob|not posting the §7 sign-off|declin[a-z]* the §7 sign-off" \
      <<<"$latest_review"; then
    echo "FAIL: the latest Claude review ruled PR #$pr human-owned (§7) but needs-rob was never applied"
    fail=1
  fi
fi

# 3) No check-run at this SHA is red or unfinished (latest attempt per name;
#    skipped/neutral conclusions are fine — e.g. the prod smoke on PRs).
bad_runs=$(gh api "repos/$repo/commits/$sha/check-runs?per_page=100" --paginate \
  | jq -rs '[.[].check_runs[]] | group_by(.name) | map(max_by(.started_at))
        | map(select(((.conclusion // "pending") == "success"
                    or (.conclusion // "pending") == "neutral"
                    or (.conclusion // "pending") == "skipped") | not))
        | map("\(.name): \(.status)/\(.conclusion // "pending")") | join("; ")')
if [ -n "$bad_runs" ]; then
  echo "FAIL: check-runs not green at $sha — $bad_runs"
  fail=1
fi

# 4) No commit-status context (latest per context) is non-success.
bad_statuses=$(gh api "repos/$repo/commits/$sha/status" \
  --jq '[.statuses[] | select(.state != "success") | "\(.context): \(.state)"] | join("; ")')
if [ -n "$bad_statuses" ]; then
  echo "FAIL: commit statuses not green at $sha — $bad_statuses"
  fail=1
fi

if [ "$fail" != "0" ]; then
  echo "verify-pr-gate: RED — do not merge PR #$pr at $sha"
  exit 1
fi
echo "verify-pr-gate: GREEN — PR #$pr verified at $sha"
