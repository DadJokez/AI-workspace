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

Requires Node 20 (see [`.nvmrc`](./.nvmrc)) and pnpm 9+.

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

Health check: `curl http://localhost:3000/api/health`

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
