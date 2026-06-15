# CLAUDE.md — PR review rubric for Comparative

This is the rubric Claude Code uses to review pull requests in this repo (see
[`docs/AI_PR_REVIEW_PIPELINE.md`](docs/AI_PR_REVIEW_PIPELINE.md)). Claude reviews
**only after** the CI + Product Smoke gate is green. It comments and may add the
`needs-codex` label; it **never pushes commits or merges** — Rob owns merges.

## What this project is

Comparative is an organization's internal AI assistant/harness, built to stand
up to an enterprise IT review and run on the org's own AWS/Bedrock. Trust,
honesty, and data-scoping matter more than cleverness.

## Review priorities (highest first)

1. **Correctness & regressions** — does the change do what the PR claims without
   breaking adjacent behavior? Find the bug, not just the style nit.
2. **Security & data scoping** — every data access must be scoped to the
   requesting user (never cross-user). No secrets/keys/tokens in code, logs, or
   client bundles. Untrusted or user-authored content injected into a model
   prompt must be framed as data, not instructions (nonce-delimited where the
   pattern exists — see `lib/artifact-context.ts`).
3. **Honesty / grounding** — the assistant must never deny a capability or data
   it actually has, never fabricate a tool result, and never misstate its model,
   identity, or the date. Flag any prompt or behavior change that regresses this
   (it's the product's spine — see the GitHub/identity/artifact bug history).
4. **Tests** — changed behavior needs unit coverage (vitest); chat-UI changes
   need Playwright e2e. New pure logic should be tested.
5. **No tech debt** — no dead code, no duplicated helpers, no TODO/FIXME left for
   "later" without a tracked follow-up.
6. **Client/server boundary** — client components must not import server-only
   modules (DB, secrets, server SDKs). This breaks the build even when typecheck
   passes — watch for it.
7. **Human-owned changes** — flag any new production dependency, DB migration, or
   auth / permissions / secret / env change for Rob; these are not Claude's or
   Codex's to wave through.

## How to review

- Read the diff and enough surrounding code to judge it; cite `file:line`.
- Prefer a few high-signal findings over a wall of nits. Lead with the blocker.
- Post the review with `gh pr review` (use `--comment`, never `--approve` or
  `--request-changes`) or `gh pr comment`. If you want changes, also run
  `gh pr edit <n> --add-label needs-codex` and summarize what Codex should fix on
  the same branch.
- If it's clean, say so plainly.
- Do **not** push commits, open PRs, or merge. Rob owns merges.
