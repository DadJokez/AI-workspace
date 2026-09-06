# CLAUDE.md — PR review rubric for Comparative

This is the rubric Claude Code uses to review pull requests in this repo (see
[`docs/AI_PR_REVIEW_PIPELINE.md`](docs/AI_PR_REVIEW_PIPELINE.md)). Claude reviews
**only after** the CI + Product Smoke gate is green. It comments and may add the
`needs-codex` label (Codex must fix something) or the `needs-rob` label (Rob must
decide, §7); it **never pushes commits or merges** — Rob owns merges.

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
   Codex's to wave through — **except the delegations below**, which Rob has
   granted so routine hygiene does not stall on a one-line comment.

   **Rob's standing delegations (2026-09-03, "i trust you - keep going", "just
   fix it"):** Claude may post the §7 sign-off itself, citing this section,
   when the PR is otherwise green (CI + this review) and the change is one of:
   - **Security-patch dependency pins** — `pnpm.overrides` or same-major bumps
     whose only purpose is to clear a published advisory, lockfile-only, with
     the full production build green (e.g. #852, #863).
   - **Tightening-only enforcement changes** — permissions behavior that can
     only refuse or pause more, never allow more (e.g. #861's fail-closed
     default), with the tool classification table in the PR body.
   Everything else in this list — new production dependencies, DB migrations,
   secrets/IAM, auth surface, loosening any gate — stays Rob's, on the PR.

   For those, apply the `needs-rob` label (`gh pr edit <n> --add-label
   needs-rob`) **before** posting the review and say so in the review's first
   line; the `Claude verdict` status stays red until Rob removes the label.
   Never remove `needs-rob` — not Claude Code, not Codex; only Rob does, and
   the gate treats a bot removal as if it never happened. A §7 sign-off is
   valid only when posted by the review lane (`github-actions`) on a PR it did
   not author; a sign-off posted through Rob's token by an authoring session
   is void.

## How to review

- Read the diff and enough surrounding code to judge it; cite `file:line`.
- Prefer a few high-signal findings over a wall of nits. Lead with the blocker.
- Post the review with `gh pr review` (use `--comment`, never `--approve` or
  `--request-changes`) or `gh pr comment`. If you want changes, also run
  `gh pr edit <n> --add-label needs-codex` and summarize what Codex should fix on
  the same branch.
- If the change is Rob's under §7 (outside the standing delegations), run
  `gh pr edit <n> --add-label needs-rob` *before* `gh pr review`, and open the
  review with that fact. Never remove `needs-rob`.
- If it's clean, say so plainly.
- Do **not** push commits, open PRs, or merge. Rob owns merges.
