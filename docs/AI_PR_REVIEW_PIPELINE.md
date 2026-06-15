# AI PR Review Pipeline

This document is the shared source of truth for coordinating Codex, Claude Code,
GitHub Actions, and human review in this repository.

## Roles

- Codex implements changes, writes or updates tests, opens PRs, and addresses
  review feedback.
- GitHub Actions runs the required validation gates.
- Claude Code reviews PRs only after `CI` and `Product Smoke` are green for the
  same commit.
- Rob owns merges, dependency approval, auth or secret changes, and escalation
  decisions.

## Target Flow

1. Rob prompts Codex with a scoped task.
2. Codex creates a focused branch, implements the task, validates locally when
   practical, and opens a PR.
3. GitHub Actions runs `CI` and `Product Smoke`.
4. `CI` must include lint, typecheck, unit tests, and build. `Product Smoke`
   must include the local Playwright browser smoke tests.
5. New PR commits get a failing `Claude verdict` status until Claude reviews
   that exact head SHA.
6. Claude Code runs only after `CI` and `Product Smoke` both complete
   successfully for the same commit.
7. Claude reviews the PR against `CLAUDE.md`.
8. If Claude is clean, Claude removes any stale `needs-codex` label and the
   `Claude verdict` status turns green.
9. If Claude requests changes, Claude applies the `needs-codex` label and the
   `Claude verdict` status stays red.
10. If Claude fails to complete, the `Claude verdict` status stays red.
11. Rob re-prompts Codex to address the review comments on that PR.
12. Codex pushes follow-up commits to the same branch, restarting the loop.
13. Rob reviews and merges only after the required checks, including
    `Claude verdict`, are green.

## Required Repository State

- `.github/workflows/ci.yml` runs lint, typecheck, unit tests, and build.
- `.github/workflows/product-smoke.yml` runs the local Playwright browser
  smoke tests.
- `.github/workflows/claude.yml` handles explicit `@claude` mentions.
- `.github/workflows/claude-code-review.yml` handles automatic review after
  `CI` and `Product Smoke` both succeed, then publishes the final
  `Claude verdict` commit status.
- `.github/workflows/claude-verdict.yml` publishes an initial red
  `Claude verdict` status for new PR commits and refreshes the status when
  labels or reviews change.
- `CLAUDE.md` contains Claude's review rubric.
- `AGENTS.md` contains Codex's repository instructions and should reference this
  document.
- The GitHub label `needs-codex` exists.
- The repository has the `CLAUDE_CODE_OAUTH_TOKEN` Actions secret configured.
- Codex Cloud has GitHub access for this repository.
- Branch protection for `main` requires:
  - `lint + typecheck + build`
  - `local browser smoke`
  - `Claude verdict`
  - resolved conversations

Approving reviews are a human workflow expectation, not a current GitHub branch
protection requirement. Rob still owns merge judgment even when all mechanical
checks are green.

## Claude Review Gate

The automatic Claude review workflow should trigger from `workflow_run` on the
`CI` and `Product Smoke` workflows and should only run after both conclusions
are `success` for the same commit.

Claude should review the pull request associated with the workflow run, not the
Actions run URL. If the workflow cannot resolve exactly one pull request, it
should stop instead of guessing.

Claude may read files, inspect diffs, and use `gh` for PR metadata, checks,
comments, labels, and reviews. It must not push commits or merge PRs.

The required `Claude verdict` status is the mechanical merge gate:

- `failure` if the current head SHA does not have a
  `<!-- claude-reviewed: SHA -->` marker.
- `failure` if the PR has the `needs-codex` label.
- `failure` if the Claude Code review action fails to complete.
- `success` only when the current head SHA was reviewed and `needs-codex` is
  absent.

## Codex Expectations

For every implementation PR, Codex should:

- Keep the branch focused on the requested task.
- Avoid new production dependencies unless Rob explicitly approves them.
- Add or update tests for changed behavior.
- Run the relevant local validation before handing off.
- Include a concise PR summary, validation notes, and risks.
- Address Claude feedback on the existing PR branch rather than opening a
  duplicate PR.

## Human-Owned Decisions

Rob must approve, even where GitHub does not enforce it mechanically:

- Merges.
- New dependencies.
- Database migrations.
- Auth, permissions, secrets, or environment variable changes.
- Production deploys.
- Auto-merge policy changes.

## Known Setup Sequence

1. Claude runs its GitHub app setup and opens the generated workflow PR.
2. Rob merges the Claude setup PR.
3. Codex opens a follow-up PR that adds `AGENTS.md`, `CLAUDE.md`, updates `CI`
   to include Playwright, tunes `claude-code-review.yml`, and creates or
   documents the `needs-codex` label.
4. Rob runs a small end-to-end test PR to confirm the loop.

## Setup status

This is **dev tooling for building Comparative — not part of the product.** It's
just repo CI; it doesn't touch the app or go through any IT review, so it uses
the simplest auth that works.

Wired by the `feat/ai-pr-review-pipeline` PR:

- `CLAUDE.md` (review rubric) and `AGENTS.md` (Codex instructions).
- `.github/workflows/claude-code-review.yml` — auto-review, triggered by `CI`
  **and** `Product Smoke` succeeding for the same commit (runs once both are
  green, dedup-guarded).
- `.github/workflows/claude-verdict.yml` — required `Claude verdict` status for
  branch protection.
- `.github/workflows/claude.yml` — `@claude` on-demand.
- The `needs-codex` label.

Auth is the **`CLAUDE_CODE_OAUTH_TOKEN`** secret (Claude GitHub App /
`claude setup-token`) — no Anthropic API key, no AWS/Bedrock setup.

Done: `CLAUDE_CODE_OAUTH_TOKEN` is set, Codex Cloud is connected, `Claude
verdict` is required on `main`, and the throwaway fail-path PR confirmed Claude
can block a PR that passes CI and Playwright.
