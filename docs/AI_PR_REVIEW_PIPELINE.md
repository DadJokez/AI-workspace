# AI PR Review Pipeline

This document is the shared source of truth for coordinating Codex, Claude Code,
GitHub Actions, and human review in this repository.

## Roles

- Codex implements changes, writes or updates tests, opens PRs, and addresses
  review feedback.
- GitHub Actions runs the required validation gates.
- Claude Code reviews PRs only after the required CI gate is green.
- Rob owns merges, dependency approval, auth or secret changes, and escalation
  decisions.

## Target Flow

1. Rob prompts Codex with a scoped task.
2. Codex creates a focused branch, implements the task, validates locally when
   practical, and opens a PR.
3. GitHub Actions runs `CI`.
4. `CI` must include lint, typecheck, unit tests, build, and the local
   Playwright browser smoke tests.
5. Claude Code runs only after `CI` completes successfully.
6. Claude reviews the PR against `CLAUDE.md`.
7. If Claude approves, Rob reviews and merges.
8. If Claude requests changes, Claude applies the `needs-codex` label.
9. Rob re-prompts Codex to address the review comments on that PR.
10. Codex pushes follow-up commits to the same branch, restarting the loop.

## Required Repository State

- `.github/workflows/ci.yml` is the single green gate for automated review.
- `.github/workflows/claude.yml` handles explicit `@claude` mentions.
- `.github/workflows/claude-code-review.yml` handles automatic review after
  `CI` succeeds.
- `CLAUDE.md` contains Claude's review rubric.
- `AGENTS.md` contains Codex's repository instructions and should reference this
  document.
- The GitHub label `needs-codex` exists.
- The repository has the `ANTHROPIC_API_KEY` Actions secret configured.
- Codex Cloud has GitHub access for this repository.

## Claude Review Gate

The automatic Claude review workflow should trigger from `workflow_run` on the
`CI` workflow and should only run when the conclusion is `success`.

Claude should review the pull request associated with the workflow run, not the
Actions run URL. If the workflow cannot resolve exactly one pull request, it
should stop instead of guessing.

Claude may read files, inspect diffs, and use `gh` for PR metadata, checks,
comments, labels, and reviews. It must not push commits or merge PRs.

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

Rob must approve:

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
- `.github/workflows/claude.yml` — `@claude` on-demand.
- The `needs-codex` label.

Auth is the **`CLAUDE_CODE_OAUTH_TOKEN`** secret (Claude GitHub App /
`claude setup-token`) — no Anthropic API key, no AWS/Bedrock setup.

Done: `CLAUDE_CODE_OAUTH_TOKEN` is set, and Codex Cloud is connected (it's
already opening `codex/*` PRs). Remaining: merge this PR, then open a small
throwaway PR and confirm `CI` + `Product Smoke` go green and Claude posts a
review.

