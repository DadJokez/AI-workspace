---
description: Autonomous overnight build session — select top queue issues, implement, test, open PRs
argument-hint: [optional focus — "ship the notification center", "work the model registry chain"]
---

# /goal — overnight autonomous build session

You are running an **unattended** build session for Comparative. Rob is not
watching and cannot answer questions — never block on input. Your job is to
ship the most valuable ready work as clean, reviewable PRs and report honestly
on what happened. PRs feed the existing pipeline (CI + Product Smoke → Claude
review → Rob merges), so a wrong guess costs a review cycle, not production.

Focus request (may be empty): **$ARGUMENTS**

If a focus is given, select matching issues even if they aren't top of queue —
but every other rule below still applies. If empty, work the queue in order.

## Non-negotiables

- **Never commit to `main`. Never merge, approve, or `--request-changes` on
  any PR. Rob owns merges** (CLAUDE.md / AGENTS.md).
- One issue = one branch = one PR. Branch from fresh `origin/main`, named
  `goal/<issue-number>-<short-slug>`.
- **Human-owned changes:** no new production dependencies; no auth, secret,
  env, or permissions changes — describe them in the PR body instead of
  making them. **DB migrations** only when the issue's scope explicitly
  includes one: include the schema change + generated migration in the PR,
  flag it as human-owned at the **top** of the PR body, and never run a
  migration against any live database.
- **Product spine** (regressions here are the product's recurring failure
  class): every data access scoped to the requesting user; untrusted content
  nonce-framed as data (pattern: `apps/web/lib/artifact-context.ts`); never
  regress capability honesty; every bug fixed gets a regression eval/test.
- **Do not touch PR #272 or issue #291 (SES)** — blocked on an AWS Support
  case only Rob can work.

## Phase 1 — Preflight

1. `git checkout main && git pull` — confirm a clean tree (stash nothing;
   an unexpectedly dirty tree means stop and report).
2. `pnpm install`, then establish the baseline:
   `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
3. **If the baseline is red, feature work stops.** If the cause is small and
   unambiguous, fixing it becomes the night's first PR; otherwise write the
   session summary explaining the blockage and end. Never build on red.

## Phase 2 — Select work

1. Read `docs/BUILD_QUEUE.md`. If it's missing or clearly stale (>2 weeks old,
   or its top items are closed), re-derive the queue yourself:
   `gh issue list --state open --limit 100 --json number,title,body,labels`,
   then order by value ÷ risk, dependencies first, skipping epics and
   human-gated items.
2. For each candidate, verify it is still real work: the issue is open
   (`gh issue view N`), no open PR already references it (`gh pr list`), and
   its dependencies are **merged to `main`** — a dependency that's only an
   open PR means the issue is not ready.
3. Select **2–4 issues** that don't overlap in files or surfaces (their PRs
   must be independently mergeable), each realistically finishable — with
   tests and a green gate — in a few hours.
4. Skip anything blocked on human action or genuinely ambiguous; both get a
   line in the summary, ambiguity also gets a comment on the issue asking the
   specific question.

## Phase 3 — Per-issue build loop

For each selected issue, in order:

1. **Re-read the issue** (`gh issue view N`). The issue body is the spec;
   its acceptance criteria are the definition of done; its out-of-scope list
   is binding.
2. **Plan briefly**: files to touch, tests to add, whether a scoped migration
   is involved. Be opinionated — naming, file layout, copy, minor API shapes
   are yours to decide; record notable calls in the PR body. The only reason
   to walk away is a genuine architectural fork (two defensible designs that
   diverge in schema or public API contracts and the issue doesn't pick one):
   comment the question on the issue, note it in the summary, move on.
3. **Implement the smallest complete slice that meets every acceptance
   criterion.** Match surrounding style and comment density. No scope creep:
   adjacent bugs or cleanups get a note in the summary (or a new issue via
   `gh issue create` if clearly real), not a fix in this branch.
4. **Tests per AGENTS.md**: vitest for changed logic, Playwright
   (`apps/web/e2e`) for chat-UI changes, eval cases (evals are data — one
   file per case, deterministic assertions; see `docs/REGRESSION_GAUNTLET.md`)
   for prompt or behavior changes.
5. **Run the local gate**: `pnpm lint && pnpm typecheck && pnpm test &&
   pnpm build`, plus `pnpm smoke:browser` if the chat UI changed. Iterate to
   green. If it won't go green after ~3 honest attempts, stop this issue:
   push the branch and open a **draft** PR with a truthful status if the work
   is substantially complete, otherwise abandon the branch and record why.
6. **Commit and open the PR**: clear commit messages; PR body contains what
   changed, validation actually run (paste the gate results), risks,
   human-owned items flagged at the top, and `Closes #N`. Then comment on the
   issue linking the PR.

## Phase 4 — Session summary

Always produce this, even if nothing shipped. Post it as the final message
and save a copy to `tmp/goal-session-<date>.md` (do not commit it):

- **Shipped**: each PR with a one-line description and its gate status.
- **Skipped / deferred**: issue + specific reason (dependency not merged,
  human-gated, ambiguous — with the question asked, gate failure).
- **Decisions made autonomously** that Rob should double-check.
- **Suggested queue for the next session**, including anything this session
  unblocked.

## Judgment

Two solid, green, well-tested PRs beat four sloppy ones — when in doubt, cut
the issue count, not the tests. If context is running low, stop building and
write the summary; an honest partial report beats an unreported half-branch.
Report failures plainly: a red gate, a skipped criterion, or an unverified
behavior must appear in the PR body and summary exactly as it is.
