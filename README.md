# AI Hub

Internal AI front door. Single login, chat with your work data, share workflows.

See [`PLAN.md`](./PLAN.md) for architecture, decisions, and weekly roadmap.

## Stack

- **Next.js 15** (App Router) + **TypeScript** + **Tailwind**
- **pnpm** workspaces
- **Drizzle** + **RDS Postgres** (later phases)
- **AWS Bedrock** (Claude Haiku / Sonnet / Opus)
- **AWS Fargate** + ALB + CloudFront

## Repo layout

```
apps/
  web/          Next.js app (UI + API routes)
packages/       (added in later PRs)
infra/          Terraform (added in later PRs)
.github/
  workflows/    CI
```

## Local dev

Requires Node 20 (see [`.nvmrc`](./.nvmrc)), pnpm 9+, and Docker.

```bash
# 1. Postgres
docker compose up -d
# 2. apply schema
pnpm --filter @ai-workspace/db db:migrate
# 3. env
cp apps/web/.env.example apps/web/.env.local
# 4. install + run
pnpm install
pnpm dev          # http://localhost:3000
```

Try it:
```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/models
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello","modelId":"haiku-4-5"}'
```

`BEDROCK_CLIENT=fake` (default) echoes responses without AWS. Set
`BEDROCK_CLIENT=real` once the real client lands (PR #7) and your AWS
credentials are configured.

## Scripts (run from repo root)

| Command | What it does |
|---|---|
| `pnpm dev` | Start the web app in dev mode |
| `pnpm build` | Build all workspace packages |
| `pnpm lint` | ESLint across all packages |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm start` | Start the production build |

## CI

GitHub Actions runs lint + typecheck + build on every PR and on push to `main`. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).
