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
- Do **not** add a new production dependency, a database migration, or any
  auth / secret / env / permissions change without Rob's explicit approval —
  call it out in the PR description instead of doing it.
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

## Cursor Cloud specific instructions

Standard setup/commands live in [`README.md`](./README.md) (Local dev, Scripts)
and the package scripts. The notes below are only the non-obvious caveats for
this cloud VM. The startup update script already runs `pnpm install`.

- **Node:** the effective `node` is the fixed `/exec-daemon/node` wrapper (v22),
  which overrides `nvm`/`.nvmrc`'s pin to 20. v22 satisfies `engines >=20`, so
  this is fine — don't fight it. `pnpm` resolves from the default nvm node, so
  `node`/`pnpm`/`pnpm exec tsx` all work without sourcing nvm.
- **Postgres:** Docker is **not** available here. Postgres 16 is installed as a
  local apt cluster instead of via `docker compose`. Start it with
  `sudo pg_ctlcluster 16 main start` (check with `pg_lsclusters`). The `aihub`
  role/db that match `DATABASE_URL` already exist. The compose file is unused.
- **Env loading gotcha:** `pnpm dev` (Next.js) auto-loads `apps/web/.env.local`,
  but standalone scripts do **not**. `db:migrate` and the `scripts/*.ts` seeders
  read `DATABASE_URL` from the process env only, so prefix them, e.g.
  `DATABASE_URL=postgres://aihub:aihub_dev@localhost:5432/aihub pnpm --filter @ai-workspace/db db:migrate`.
- **No AWS needed:** `apps/web/.env.local` uses `BEDROCK_CLIENT=fake`, which
  echoes `"[fake] you said: …"` so chat/persistence work with no AWS account.
  Set `BEDROCK_CLIENT=real` + `AWS_REGION` only to hit live Bedrock.
- **Auth has no local password path** — sign-in is GitHub-OAuth only. To exercise
  authenticated flows without OAuth creds: seed a user with
  `apps/web/scripts/seed-auth-smoke.ts`, then mint a `next-auth.session-token`
  JWT signed with `NEXTAUTH_SECRET` and set it as a cookie (see the helper in
  `apps/web/e2e/helpers/auth.ts`). `pnpm smoke:browser:auth` does this end-to-end.
- **Playwright browsers are not pre-installed.** Before `pnpm smoke:browser*`,
  run `pnpm --filter @ai-workspace/web exec playwright install chromium`. System
  `google-chrome` is available at `/usr/local/bin/google-chrome` for headed runs.
