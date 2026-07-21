#!/usr/bin/env bash
# verified-merge.sh <pr-number>
#
# #479: the ONLY sanctioned way to merge a PR in this repo. Verifies the full
# gate on the PR's current head SHA (scripts/verify-pr-gate.sh), then merges
# with --match-head-commit pinned to that verified SHA, so a commit pushed
# between verification and merge aborts the merge instead of slipping through
# unreviewed (the TOCTOU that produced incident #479).
#
# Never use `gh pr merge --auto` here: without branch protection GitHub
# considers every PR "clean", and gh silently falls back from arming
# auto-merge to merging immediately — that fallback IS the #479 incident.
set -euo pipefail

pr="${1:?usage: verified-merge.sh <pr-number>}"
repo="${GH_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
sha=$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)

"$(dirname "$0")/verify-pr-gate.sh" "$pr" "$sha"

exec gh pr merge "$pr" --repo "$repo" --squash --delete-branch \
  --match-head-commit "$sha"
