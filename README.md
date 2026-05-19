# AI Hub

Internal AI front door for Georgia-Pacific. Single login, chat with your work data, run scheduled agents, share workflows.

See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for the five journeys and integration roadmap.
See [`PLAN.md`](./PLAN.md) for weekly ship plan and architectural decisions.
See [`docs/ENTERPRISE_READINESS.md`](./docs/ENTERPRISE_READINESS.md) for the IT readiness posture.

## Stack

- **Next.js 15** (App Router) + **TypeScript** + **Tailwind**
- **pnpm** workspaces
- **Drizzle** + **RDS Postgres**
- **NextAuth v4** with GitHub OAuth (POC identity — swaps to PingOne OIDC for enterprise)
- **Cursor SDK** (`@cursor/sdk`) — default agent runtime
- **AWS Bedrock** (`converseStream`) — fallback runtime (`RUNTIME=bedrock`)
- **GitHub MCP** (`api.githubcopilot.com/mcp/`) — first working tool integration
- **AWS App Runner** — current POC/pilot hosting (CI/CD via CodeBuild on push to `main`)
- **ECS on Fargate** — documented enterprise hosting target, including the chat-run worker

## Repo layout

```
apps/
  web/            Next.js app (UI + API routes + auth)
packages/
  db/             Drizzle schema + client + migrations
  cursor-runtime/ AgentRuntime seam (CursorRuntime + BedrockRuntime + factory)
  agent/          Tool/model registries + Bedrock loop
  mcp-servers/    Local integration stubs; GitHub MCP is remote and mounted by apps/web/lib/oauth/mcp-servers.ts
.github/
  workflows/      CI (lint + typecheck + build on every PR and main push)
docs/
  ARCHITECTURE.md End-state component design and request flow
  ROADMAP.md      Five journeys, integration tiers, flagship use cases
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
# edit .env.local — fill in NEXTAUTH_SECRET, GITHUB_AUTH_CLIENT_ID/SECRET, DATABASE_URL, CURSOR_API_KEY
# 4. install + run
pnpm install
pnpm dev          # http://localhost:3000
```

## Key env vars

| Var | Purpose |
|---|---|
| `RUNTIME` | `cursor` (default) or `bedrock` |
| `CURSOR_API_KEY` | Required for Cursor runtime |
| `CURSOR_RUNTIME_MODE` | `local` (current process) or `cloud` (Cursor Cloud durable runs) |
| `CURSOR_CLOUD_REPO_URL` / `CURSOR_CLOUD_REPO_REF` | Optional repo and starting ref for Cursor Cloud agents |
| `NEXTAUTH_SECRET` | NextAuth JWT signing secret |
| `GITHUB_AUTH_CLIENT_ID` / `GITHUB_AUTH_CLIENT_SECRET` | GitHub OAuth App for sign-in |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Separate GitHub OAuth App for per-user MCP tokens |
| `OAUTH_ENCRYPTION_KEY` | 32-byte AES-256-GCM key for encrypting stored OAuth tokens |
| `DATABASE_URL` | Postgres connection string |
| `CHAT_MAX_REQUEST_BYTES` | Max `/api/chat` request body size before parsing |
| `CHAT_MAX_MESSAGE_CHARS` | Max user message length |
| `CHAT_RATE_LIMIT_WINDOW_MS` | Fixed-window rate-limit duration |
| `CHAT_RATE_LIMIT_REQUESTS` | Per-user chat request count in the window |
| `CHAT_RUN_IN_PROCESS_WORKER` | `1`/unset runs accepted chat work in the web process; `0` disables that bridge for dedicated worker deployments |
| `CHAT_RUN_WORKER_LEASE_MS` | Lease duration for claimed background chat runs |
| `CHAT_WORKER_RUNTIME_TIMEOUT_MS` | Max runtime duration for a background chat run |
| `CHAT_RUN_PROVIDER_POLL_INTERVAL_MS` | Poll interval when reconciling an existing Cursor Cloud provider run |

## Scripts (run from repo root)

| Command | What it does |
|---|---|
| `pnpm dev` | Start the web app in dev mode |
| `pnpm build` | Build all workspace packages |
| `pnpm lint` | ESLint across all packages |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm start` | Start the production build |
| `pnpm --filter @ai-workspace/web worker:chat-runs` | Run the DB-backed chat-run worker loop |

## CI / Deploy

GitHub Actions runs lint + typecheck + build on every PR and on push to `main`.
Merging to `main` triggers a CodeBuild pipeline that builds the web image, the
chat-run worker image, and a small migration image. CodeBuild runs Drizzle
migrations against the App Runner database before pushing the new app image to
ECR; App Runner then auto-deploys the updated `latest` image. The worker image
is tagged separately for ECS/Fargate.

## Enterprise Readiness

The current stack is ready for POC/pilot work, not yet for broad enterprise
scale. The hosting direction is App Runner for pilot and ECS/Fargate for
enterprise production, with RDS Proxy/Aurora Postgres evaluated before broad
rollout. The current readiness posture, including dependency audit triage,
health checks, rate limits, redaction/retention, Secrets Manager/KMS/IaC, and
the 1k/10k/100k load-test model, lives in
[`docs/ENTERPRISE_READINESS.md`](./docs/ENTERPRISE_READINESS.md).
