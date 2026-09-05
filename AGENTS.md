# AGENTS.md — Codex instructions for Comparative

Codex implements scoped tasks and opens pull requests in this repo. The full
automation loop is in [`docs/AI_PR_REVIEW_PIPELINE.md`](docs/AI_PR_REVIEW_PIPELINE.md);
Claude's review rubric is [`CLAUDE.md`](CLAUDE.md).

## The loop

Rob prompts you with a scoped task → you branch, implement, validate, and open a
PR → `CI` and `Product Smoke` run → Claude reviews once both are green → if Claude
adds the `needs-codex` label, Rob re-prompts you and you fix on the **same
branch** → Rob merges.

## Rules

- Keep the branch focused on the requested task. Never commit to `main` directly.
- Add or update tests for changed behavior — vitest unit tests, and Playwright
  e2e (`apps/web/e2e`) when you touch the chat UI.
- Run the local gate before handing off:
  `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, plus
  `pnpm smoke:browser` when the change touches the chat UI.
- `pnpm test:coverage` runs the same unit lane with v8 coverage and prints a
  per-package table (report-only, no thresholds) — use it to check that the
  code you changed is actually exercised.
- Do **not** add a new production dependency, a database migration, or any
  auth / secret / env / permissions change without Rob's explicit approval —
  call it out in the PR description instead of doing it.
- Never add or remove the `needs-rob` label. It marks a change Rob must decide
  (`CLAUDE.md` §7) and keeps `Claude verdict` red until Rob removes it himself.
- The PR summary must include: what changed, validation notes, and risks.
- Address Claude's review on the existing PR branch (push follow-up commits) —
  never open a duplicate PR.
- Match the surrounding code's style, naming, and comment density.

## Repo quickstart

- pnpm workspace. Next.js 15 app in `apps/web`; shared libraries in `packages/*`.
- Gate: `.github/workflows/ci.yml` (lint / typecheck / unit tests / build) and
  `.github/workflows/product-smoke.yml` (Playwright browser smoke).
- Tests: vitest in `apps/web/__tests__`, Playwright in `apps/web/e2e`.
- The product runs on AWS/Bedrock; the runtime is model- and provider-portable
  behind a runtime seam — keep it that way.
