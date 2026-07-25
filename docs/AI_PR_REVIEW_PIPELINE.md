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
  `Claude verdict` commit status. It records a `Claude review completed`
  commit status only after the Claude review action completes successfully;
  if that status already exists for the SHA, it republishes the verdict so
  stale red statuses do not block clean PRs. A commit status — not a PR
  comment — is the review-happened fact because posting one requires
  `statuses: write`, which PR commenters and the `@claude` workflow's token
  do not have (#459).
- `.github/workflows/claude-verdict.yml` publishes an initial red
  `Claude verdict` status for new PR commits and refreshes the status when
  labels or reviews change.
- `CLAUDE.md` contains Claude's review rubric.
- `AGENTS.md` contains Codex's repository instructions and should reference this
  document.
- The GitHub label `needs-codex` exists.
- The repository has the `CLAUDE_CODE_OAUTH_TOKEN` Actions secret configured.
- Codex Cloud has GitHub access for this repository.
- `.github/workflows/merge-gate-audit.yml` re-verifies the full gate on every
  push to `main` and files a labeled incident issue on any violation (#479).

## Merge Protocol (#479, #667)

**Server-side branch protection enforces the merge gate.** As verified on
2026-07-25, `main` requires eight status contexts, is `strict` (branches must
be up to date before merge), and has `enforce_admins` enabled — no bypass for
anyone, including the repository owner. Force pushes and branch deletion are
blocked. Required signatures, required linear history, and required
conversation resolution are *not* enabled.

The eight required contexts (`gh api repos/DadJokez/AI-workspace/branches/main/protection`):

| Context | Workflow |
|---|---|
| `lint + typecheck + build` | `ci.yml` |
| `dependency CVE audit` | `ci.yml` |
| `scoping integration (real Postgres)` | `ci.yml` |
| `local browser smoke` | `product-smoke.yml` |
| `authenticated browser smoke` | `product-smoke.yml` |
| `browser smoke (desktop-chromium)` | `product-smoke.yml` |
| `browser smoke (mobile-chromium)` | `product-smoke.yml` |
| `Claude verdict` | `claude-verdict.yml` / `claude-code-review.yml` |

Protection was restored 2026-07-21 after the plan re-upgrade. The original
#479 root cause was the paid plan lapsing, which made GitHub *silently drop*
protection — at the time the repository was private, and branch protection on
private repositories required the paid plan. **The repository is public as of
2026-07-25** (a deliberate decision), so that specific plan-lapse failure mode
no longer applies; the audit backstop below is retained anyway because silent
protection loss has other causes and the failure is invisible by construction.

Consequences:

- **Merging is plain `gh pr merge <n> --squash --delete-branch` once checks
  are green.** GitHub refuses the merge otherwise. There is no bespoke merge
  tooling: `scripts/verified-merge.sh` was retired in #667 because branch
  protection now does server-side what the script did client-side, and a
  client-side gate is advisory by definition. Only `scripts/verify-pr-gate.sh`
  survives, and it is audit-only — it reports, it does not merge.
- **`gh pr merge --auto` stays discouraged.** It is safe while protection is
  present, but if protection ever silently vanishes again, gh falls back from
  arming auto-merge to merging immediately — the exact #479 failure — at
  precisely the moment nothing else is guarding the gate. Merge when green
  instead. `--admin` remains prohibited outside break-glass.
- **`merge-gate-audit.yml` is the backstop for silent protection loss.**
  After every push to `main` it checks that protection is still present with
  the `Claude verdict` context required, re-verifies the merged PR's head-SHA
  gate (`scripts/verify-pr-gate.sh`, audit-only), and files a
  `security`/`ops` incident issue on any violation — including direct pushes
  to `main`, which remain break-glass only. A bypass can still happen; a
  silent one cannot. Its protection-presence canary runs unconditionally; the
  finer required-contexts and `enforce_admins` checks are best-effort, because
  `GITHUB_TOKEN` cannot be granted repo Administration read.

## Public-repository consequences (2026-07-25)

The repository is public. That is a statement about the *source*, not about
production data: the deployed application is internet-reachable but
authentication-gated, and no production secret, credential, or user data lives
in this repository. Two consequences matter for this pipeline and are stated
here so nobody has to rediscover them:

- **Anyone can open a fork pull request**, which means untrusted branches can
  reach the CI workflows. GitHub's fork-run approval policy for this repo is
  `first_time_contributors`, so a first PR from a new account needs a
  maintainer to approve the workflow run — but a contributor approved once
  runs automatically thereafter.
- **Nothing in the repository may be a secret.** Workflow files, `CLAUDE.md`,
  the review prompt, the gate logic, and every doc under `docs/` are readable
  by an attacker designing a PR to slip past the review. The gate must be
  sound under that assumption; it is not, and cannot be, secret.

The residual CI/supply-chain threats — including a forged `Claude verdict` and
the `workflow_run` privilege boundary — are enumerated in
[`docs/security/THREAT_MODEL.md`](./security/THREAT_MODEL.md) under
"CI and supply-chain threats" rather than duplicated here.

The production AWS CodeBuild project (`ai-workspace-build`) is intentionally
outside the PR merge gate. It deploys merged `main` commits only. Its webhook
must stay filtered to `PUSH` events where `HEAD_REF` is `^refs/heads/main$`,
with pull-request build approval disabled; otherwise GitHub can show cosmetic
red CodeBuild statuses on otherwise clean PR commits.

The AgentCore runtime remains owned by `AiWorkspaceAgentCoreSpikeStack`.
The main x86 CodeBuild job launches the dedicated, CDK-owned
`ai-workspace-agentcore-build` ARM project for the exact source commit while it
builds the ECS images. The child has no webhook, reports no GitHub status, and
cannot recursively launch itself. The parent waits for it before updating the
stack from the current synthesized template with the same commit-SHA
`AgentImageTag`. That tag is unique per commit by convention, not by registry
enforcement — the ECR repositories accept mutable tags (see
[Rollback](./PRODUCTION_DEPLOYMENT.md#rollback)).

The parent project has `concurrentBuildLimit=1`; because the ARM work runs in a
different project, that single-flight setting prevents out-of-order production
handoffs without deadlocking the child. The stack records the synthesized
template hash and monotonic CodeBuild sequence as an auditable receipt and
rejects a build that is already superseded. This avoids QEMU and public Docker
Hub pulls while keeping source infrastructure and the image on one auditable
deployment receipt.

CodeBuild never mutates the runtime directly. The stack attaches a narrowly
scoped deployment policy to `CodeBuildAIWorkspaceRole` so the parent can launch
and inspect only the dedicated child, describe only the AgentCore ECR
repository, update only this stack/runtime, and pass only its execution role.

Approving reviews are a human workflow expectation, not a current GitHub branch
protection requirement. Rob still owns merge judgment even when all mechanical
checks are green.

## Claude Review Gate

The automatic Claude review workflow should trigger from `workflow_run` on the
`CI` and `Product Smoke` workflows and should only run after both conclusions
are `success` for the same commit.

Claude should review the open pull request whose current head SHA exactly
matches the workflow run, not every pull request that happens to contain that
commit. This keeps lower pull requests in a stacked series attached to their
own base-to-head diff. If the workflow cannot resolve exactly one exact-head
match, it stops instead of guessing.

Claude may read files, inspect diffs, and use `gh` for PR metadata, checks,
comments, labels, and reviews. It must not push commits or merge PRs.

The required `Claude verdict` status is the mechanical merge gate:

- `failure` if the current head SHA does not carry a successful
  `Claude review completed` commit status.
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
