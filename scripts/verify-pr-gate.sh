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
