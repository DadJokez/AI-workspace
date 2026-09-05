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
10. If the change is human-owned under `CLAUDE.md` §7 and outside Rob's
    standing delegations, Claude applies the `needs-rob` label *before*
    posting the review, says so in the review's first line, and the
    `Claude verdict` status stays red until Rob removes the label — however
    clean the code is (#891). Only Rob removes `needs-rob`; Claude Code and
    Codex never do.
11. If Claude fails to complete, the `Claude verdict` status stays red.
12. Rob re-prompts Codex to address the review comments on that PR.
13. Codex pushes follow-up commits to the same branch, restarting the loop.
14. Rob reviews and merges only after the required checks, including
    `Claude verdict`, are green.

## Required Repository State

- `.github/workflows/ci.yml` runs lint, typecheck, unit tests, and build.
- `.github/workflows/product-smoke.yml` runs the local Playwright browser
  smoke tests.
- `.github/workflows/claude.yml` handles explicit `@claude` mentions. The
  trigger is gated on `author_association` (`OWNER`/`MEMBER`/`COLLABORATOR`)
  so that on a public repository an arbitrary commenter cannot spend a paid
  model run.
- `.github/workflows/claude-code-review.yml` handles automatic review after
  `CI` and `Product Smoke` both succeed. It is split into two jobs:
  - `review` runs the model. It reads the PR diff, title, and comments —
    attacker-authored text — so it holds **no** `statuses: write` and its
    `--allowedTools` list contains no `gh api`. A prompt-injected session
    therefore has no channel to publish a commit status.
  - `publish-verdict` holds the `statuses: write` and runs no model. It
    records `Claude review completed` only when the review step's own
    conclusion is `success`, then publishes the final `Claude verdict`. Its
    inputs are job outputs the session cannot author plus facts re-read from
    the API. If the completion status already exists for the SHA it
    republishes the verdict, so stale red statuses do not block clean PRs.

  A commit status — not a PR comment — is the review-happened fact because
  posting one requires `statuses: write`, which PR commenters, the `@claude`
  workflow's token, and now the review session itself all lack (#459).
- `.github/workflows/claude-verdict.yml` publishes an initial red
  `Claude verdict` status for new PR commits and refreshes the status when
  labels or reviews change. It also carries the merge-conflict guard: a
  conflicting PR gets no `CI` or `Product Smoke` runs at all (GitHub cannot
  build the merge ref), so this workflow — which runs on
  `pull_request_target` and needs no merge ref — reports the conflict as its
  own failing check and turns `Claude verdict` red rather than letting the
  gate go quiet. Its runs are serialized per PR (`concurrency`, queued and
  never cancelled), so the label-triggered and review-triggered runs cannot
  race a stale green past a fresh red (#891).
- `CLAUDE.md` contains Claude's review rubric.
- `AGENTS.md` contains Codex's repository instructions and should reference this
  document.
- The GitHub labels `needs-codex` and `needs-rob` exist.
  `.github/scripts/needs-rob-gate.sh` holds the sticky `needs-rob` rule and
  `needs-rob-gate.test.sh` its fixture matrix, which every verdict publisher
  runs before deciding (#891; see [The `needs-rob` hold](#the-needs-rob-hold-891)).
- The repository has the `CLAUDE_CODE_OAUTH_TOKEN` Actions secret configured.
- Codex Cloud has GitHub access for this repository.
- `.github/workflows/merge-gate-audit.yml` re-verifies the full gate on every
  push to `main` and files a labeled incident issue on any violation (#479).
- `.github/workflows/classify-changed-paths.yml` (reusable; called as the
  `classify` job by `CI` and `Product Smoke`) decides the docs-only fast lane
  from the PR diff alone. `.github/scripts/classify-docs-only.sh` holds the
  allow/deny rules and `classify-docs-only.test.sh` the fixture matrix that
  runs before every decision (#812, see below).

## Merge Protocol (#479, #667)

**Server-side branch protection enforces the merge gate.** As verified on
2026-07-25, `main` requires eight status contexts, is `strict` (branches must
be up to date before merge), and has `enforce_admins` enabled — no bypass for
anyone, including the repository owner. Force pushes and branch deletion are
blocked. Required signatures, required linear history, and required
conversation resolution are *not* enabled.

The eight required contexts (`gh api repos/DadJokez/AI-workspace/branches/main/protection`):

| Context | Workflow | Reported by |
|---|---|---|
| `lint + typecheck + build` | `ci.yml` | summary of `lint + typecheck + build [full lane]` |
| `dependency CVE audit` | `ci.yml` | summary of `dependency CVE audit [full lane]` |
| `scoping integration (real Postgres)` | `ci.yml` | summary of `scoping integration (real Postgres) [full lane]` |
| `local browser smoke` | `product-smoke.yml` | fan-in of the `browser smoke (…) [full lane]` legs and `core chat + CSV pipeline` |
| `authenticated browser smoke` | `product-smoke.yml` | summary of `authenticated browser smoke [full lane]` |
| `browser smoke (desktop-chromium)` | `product-smoke.yml` | summary of `browser smoke (desktop-chromium) [full lane]` |
| `browser smoke (mobile-chromium)` | `product-smoke.yml` | summary of `browser smoke (mobile-chromium) [full lane]` |
| `Claude verdict` | `claude-verdict.yml` / `claude-code-review.yml` | commit status |

Since #812 every workflow context is the name of a small *summary* job that
fans in its heavy `[full lane]` job. The heavy jobs were renamed so that
exactly one check run per required name exists on every commit; see the
docs-only fast lane below.

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
  gate (`scripts/verify-pr-gate.sh`, audit-only — since #891 it also reports
  RED on a `needs-rob` or `needs-codex` hold, and on a latest Claude review
  that ruled the change Rob's while `needs-rob` never landed), and files a
  `security`/`ops` incident issue on any violation — including direct pushes
  to `main`, which remain break-glass only. A bypass can still happen; a
  silent one cannot. Its protection-presence canary runs unconditionally; the
  finer required-contexts and `enforce_admins` checks are best-effort, because
  `GITHUB_TOKEN` cannot be granted repo Administration read.

## Docs-only fast lane (#812)

A pull request whose every changed path is inert documentation skips the
application gate and reaches a merge decision in about a minute; anything else
pays the full gate exactly as before. The lane is decided by
`.github/workflows/classify-changed-paths.yml`, called as the `classify` job by
both `CI` and `Product Smoke`:

- **The decision comes from git, never from the PR.** On a `pull_request` run
  the checkout is GitHub's merge commit; the classifier diffs its first parent
  (the base tip) against it with `--no-renames`, so renames and deletions show
  both paths, and feeds the list to `.github/scripts/classify-docs-only.sh`.
  Labels, titles, and bodies are author-controlled and are not consulted.
- **The allowlist is narrow:** Markdown under `docs/` and the root `README.md`.
  Deny rules run first: `CLAUDE.md`, `AGENTS.md`, and any `SKILL.md` (wherever
  they live), anything under `.github/`, `.claude/`, or `.agents/`, and
  `docs/PRODUCTION_DEPLOYMENT.md` (unit tests assert on its wording) are never
  docs-only. Everything else — code, tests, fixtures, dependencies, infra,
  scripts, specs, other root files — is the full lane. Extending the allowlist
  means a rule plus a fixture in `classify-docs-only.test.sh`; the `classify`
  job runs that matrix before every decision.
- **Everything uncertain is the full lane:** a non-`pull_request` event
  (pushes to `main` still run everything), a base other than the default
  branch, a checkout that is not the two-parent merge commit of the PR head,
  an empty diff, or any git/classifier error. The `classify` job logs the
  reason, and its step summary lists every path with its verdict.
- **Required check names are unchanged and unambiguous.** Each required
  context is a summary job that `needs` its heavy `[full lane]` job and the
  classifier. It passes on the heavy job's success, or on a skip the
  classifier explicitly asked for (`docs-only: skipped`); a skip without that
  verdict, a failure, or a cancellation is red. Because the heavy jobs carry a
  different name, exactly one check run per required name exists on every
  commit — there is no duplicate for GitHub to resolve. `infra synth` (not
  required) is simply skipped.
- **What a docs-only PR still gets:** the merge-conflict guard, the
  `Claude verdict` gate, and the automatic Claude review of the exact head —
  `CI` and `Product Smoke` both complete successfully, so `workflow_run` fires
  as usual. What it skips: install, lint, typecheck, unit tests, mocked evals,
  conformance, transcript replay, the Next.js build, the CVE audit,
  real-Postgres scoping, CDK synth, and every Playwright lane. The push to
  `main` after merge runs the full gate regardless, and the production
  CodeBuild classifier still skips the deploy on its own docs-only rule.
- **Audit:** `scripts/verify-pr-gate.sh` already accepts `skipped` check runs
  (latest attempt per name), so the `[full lane]` skips do not trip the
  merge-gate audit.

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

- `failure` if the PR has merge conflicts (`mergeable_state == "dirty"`).
- `failure` if the current head SHA does not carry a successful
  `Claude review completed` commit status.
- `failure` if the PR has the `needs-codex` label.
- `failure` if the PR is under the `needs-rob` hold (below).
- `failure` if the Claude Code review action fails to complete.
- `success` only when the current head SHA was reviewed, the PR merges
  cleanly, `needs-codex` is absent, and no `needs-rob` hold applies.

It is published only by jobs that run no model and hold `statuses: write`.
No model session in this repository has that permission, so the verdict
cannot be self-published by the thing being gated.

### The `needs-rob` hold (#891)

`needs-codex` means "Claude wants code changes"; `needs-rob` means "the code
may be clean, but this decision is Rob's" — a new production dependency, a DB
migration, auth / permissions / secret / env / IAM / OIDC surface, an action
bump on the OIDC path, or any loosening of a gate, outside the standing
delegations listed in `CLAUDE.md` §7. Before #891 the gate could not express
that state: PR #885 merged on a green verdict 37 seconds after the review ruled
it human-owned, because only `needs-codex` kept the verdict red.

- **The reviewer applies it first.** The review prompt labels `needs-rob`
  *before* running `gh pr review` and states the label in the review's first
  line, so no run of the verdict workflow can observe the review without the
  label already on the PR.
- **Only Rob removes it.** Claude Code and Codex never remove `needs-rob` —
  not on request, not to "unblock", not because a comment claims a sign-off.
  Removing the label is Rob's decision, recorded on the PR by GitHub itself.
- **It is sticky.** The review lane is a model session that reads
  attacker-authored PR text and holds `gh pr edit`, so a steered review could
  run `--remove-label needs-rob`. Label presence alone is therefore not the
  signal. Every publisher of `Claude verdict` (`claude-verdict.yml` and the
  `publish-verdict` job of `claude-code-review.yml`) also reads the PR's
  timeline and, via `.github/scripts/needs-rob-gate.sh`, treats the hold as
  present when the latest `labeled`/`unlabeled` event for `needs-rob` is an
  `unlabeled` by a bot (`github-actions[bot]`, any `[bot]` login, or no
  actor), or when the label is off the PR although its last event was
  `labeled` (which is also what a repo-wide label deletion looks like). Only
  an `unlabeled` by a human user releases it. Unreadable input fails closed.
  `needs-rob-gate.test.sh` is the fixture matrix; both publishers run it
  before deciding, exactly as `classify-changed-paths.yml` proves the
  docs-only classifier.
- **No green window.** `claude-verdict.yml` fires separately on `labeled`
  and on `pull_request_review`; its runs now share a per-PR `concurrency`
  group with `cancel-in-progress: false`, so the newest run always publishes
  last and reads the labels as they are at that moment.
- **Limits.** A removal made through Rob's own token by an authoring session
  is indistinguishable from Rob to the script; `CLAUDE.md` §7 makes such a
  removal — and any §7 sign-off not posted by the review lane — void by
  policy, and the post-merge audit is the backstop.

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

A PR waiting on one of these carries the `needs-rob` label, which keeps
`Claude verdict` red until Rob removes it (#891). Rob's decision is the label
removal itself; Claude Code and Codex never remove it.

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
- The `needs-codex` label, and since #891 the `needs-rob` label.

Auth is the **`CLAUDE_CODE_OAUTH_TOKEN`** secret (Claude GitHub App /
`claude setup-token`) — no Anthropic API key, no AWS/Bedrock setup.

Done: `CLAUDE_CODE_OAUTH_TOKEN` is set, Codex Cloud is connected, `Claude
verdict` is required on `main`, and the throwaway fail-path PR confirmed Claude
can block a PR that passes CI and Playwright.
