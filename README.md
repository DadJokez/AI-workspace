# AI Hub

Internal AI front door for Georgia-Pacific. Single login, chat with your work data, run, schedule, and event-trigger **skills** (saved agents), deploy small **apps** from conversation, share both with teammates — governed, audited, and executed on AWS by default.

See [`docs/ROADMAP.md`](./docs/ROADMAP.md) for the five journeys and integration roadmap.
See [`PLAN.md`](./PLAN.md) for weekly ship plan and architectural decisions.
See [`docs/ENTERPRISE_READINESS.md`](./docs/ENTERPRISE_READINESS.md) for the IT readiness posture.

## Stack

- **Next.js 15** (App Router) + **TypeScript** + **Tailwind**
- **pnpm** workspaces
- **Drizzle** + **RDS Postgres**
- **NextAuth v4** with GitHub OAuth (POC identity — swaps to PingOne OIDC for enterprise)
- **AWS Bedrock** (`converseStream` + MCP client) — direct fast-chat and tool-chat lanes (`RUNTIME=bedrock`)
- **Amazon Bedrock AgentCore** (`RUNTIME=agentcore`) — worker-lane runtime: durable chat, skill, scheduled, and event-triggered runs execute session-isolated in our account (`apps/agentcore-agent` container + `specs/003`)
- **GitHub MCP** (`api.githubcopilot.com/mcp/`) — first working tool integration
- **ECS on Fargate** — production hosting target with separate web, chat-worker, and memory-worker services
- **AWS App Runner** — rollback-only POC host during ECS cutover

## Repo layout

```
apps/
  web/              Next.js app (UI + API routes + auth) — chat, /skills, /apps, admin
  agentcore-agent/  Agent loop container for Bedrock AgentCore (POST /invocations SSE, GET /ping)
packages/
  db/               Drizzle schema + client + migrations (skills, schedules, event triggers, shares, apps, runs…)
  agent-runtime/   AgentRuntime seam (Bedrock + AgentCore runtimes + factory)
  agent/            Tool/model registries, Bedrock loop, MCP client (connectMcpTools)
  mcp-servers/      Local integration stubs; GitHub MCP is remote and mounted by apps/web/lib/oauth/mcp-servers.ts
infra/
  cdk/              ECS/Fargate, ALB, Route 53, Secrets Manager, AgentCore spike stack
specs/
  001-runtime-v2-autopilot/   Runtime V2 lanes + metrics packet
  002-skills-spine/           Skills, schedules, shares, thin apps (shipped)
  003-agentcore-substrate/    AgentCore research, runbook, lane decision (deployed)
.github/
  workflows/        CI (lint + typecheck + test + build on every PR and main push)
docs/
  ARCHITECTURE.md   End-state component design and request flow
  ROADMAP.md        Five journeys, integration tiers, flagship use cases
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
# edit .env.local — fill in NEXTAUTH_SECRET, GITHUB_AUTH_CLIENT_ID/SECRET, DATABASE_URL
# 4. install + run
pnpm install
pnpm dev          # http://localhost:3000
```

## Key env vars

| Var | Purpose |
|---|---|
| `RUNTIME` | `bedrock` (default) or `agentcore` |
| `AGENTCORE_RUNTIME_ARN` | Required for `RUNTIME=agentcore` — the Bedrock AgentCore runtime to invoke |
| `AGENTCORE_REGION` / `AGENTCORE_QUALIFIER` | Optional AgentCore region override / endpoint qualifier |
| `WEB_SEARCH_PROVIDER` / `BRAVE_SEARCH_API_KEY` | Direct Bedrock web-search provider configuration. The AgentCore lane resolves the same key through AgentCore Identity instead of receiving it as plaintext. |
| `BRAVE_SEARCH_CREDENTIAL_PROVIDER` | AgentCore Identity API-key provider name; set by the AgentCore CDK stack. |
| `NEXTAUTH_SECRET` | NextAuth JWT signing secret |
| `AUTH_PROVIDERS` | Sign-in allowlist, comma-separated. Default `github,email` — magic links (SES) are the universal tester path, GitHub the optional secondary. `pingone` joins the known list at the enterprise OIDC cutover. |
| `GITHUB_AUTH_CLIENT_ID` / `GITHUB_AUTH_CLIENT_SECRET` | GitHub OAuth App for sign-in |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Separate GitHub OAuth App for per-user MCP tokens |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for signed GitHub repository events; injected into the web task only |
| `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` | Notion OAuth integration token app for `/api/oauth/notion/*` |
| `NOTION_API_VERSION` | Notion API version header for OAuth token exchange; defaults to `2026-03-11` |
| `NOTION_MCP_ENDPOINT_URL` | Optional override for a compatible Comparative-owned Notion MCP gateway. Empty uses the first-party `/api/mcp/notion` endpoint. Do not point this at hosted Notion MCP. |
| `OAUTH_ENCRYPTION_KEY` | 32-byte AES-256-GCM key for encrypting stored OAuth tokens |
| `DATABASE_URL` | Postgres connection string |
| `CHAT_MAX_REQUEST_BYTES` | Max `/api/chat` request body size before parsing |
| `CHAT_MAX_MESSAGE_CHARS` | Max user message length |
| `CHAT_RATE_LIMIT_WINDOW_MS` | Fixed-window rate-limit duration |
| `CHAT_RATE_LIMIT_REQUESTS` | Per-user chat request count in the window |
| `CHAT_RUN_IN_PROCESS_WORKER` | `1`/unset runs accepted chat work in the web process; `0` disables that bridge for dedicated worker deployments |
| `CHAT_RUN_WORKER_LEASE_MS` | Lease duration for claimed background chat runs |
| `WORKER_RUN_CONCURRENCY` | Runs a single worker process executes concurrently; default 3 |
| `CHAT_RUN_MAX_ATTEMPTS` | Claims a background run gets before it is quarantined as a poison pill; default 3 |
| `CHAT_WORKER_RUNTIME_TIMEOUT_MS` | Max runtime duration for a background chat run |
| `CHAT_RUN_PROVIDER_POLL_INTERVAL_MS` | Poll interval reserved for provider-backed durable run reconciliation |
| `MEMORY_CAPTURE_IN_PROCESS_SCHEDULER` | `1`/unset schedules Vault capture in the web process after successful chats; `0` disables it for dedicated worker deployments |
| `MEMORY_CAPTURE_DELAY_MS` | Delay before reviewing queued chat transcripts for Vault suggestions; default 20 minutes |
| `MEMORY_CAPTURE_BATCH_LIMIT` | Max queued transcript windows reviewed per memory-capture batch |
| `MEMORY_CAPTURE_MAX_ATTEMPTS` | Total attempts before a failed capture is quarantined; default 3 |
| `MEMORY_CAPTURE_FAILED_RETRY_MS` | Delay before a failed capture can be reclaimed; default 15 minutes |

## Scripts (run from repo root)

| Command | What it does |
|---|---|
| `pnpm dev` | Start the web app in dev mode |
| `pnpm build` | Build all workspace packages |
| `pnpm lint` | ESLint across all packages |
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm cdk:synth` | Synthesize the AI Workspace ECS/Fargate CDK stack |
| `pnpm start` | Start the production build |
| `pnpm --filter @ai-workspace/web worker:chat-runs` | Run the DB-backed chat-run worker loop |
| `pnpm --filter @ai-workspace/web worker:memory-capture` | Run the DB-backed Vault memory capture worker loop |
| `pnpm --filter @ai-workspace/web memory:backfill -- --since <ISO> --until <ISO>` | One-shot recovery of successful chat turns missing queue rows in an explicit outage window |

## CI / Deploy

GitHub Actions runs lint + typecheck + build on every PR and on push to `main`.
Merging to `main` triggers a CodeBuild pipeline that builds the web image,
chat-run worker image, memory-capture worker image, and a small migration
image. CodeBuild reads `ai-workspace/production/app` from Secrets Manager,
runs Drizzle migrations, pushes the images to ECR, and forces new deployments
for the ECS services `ai-workspace-web`, `ai-workspace-chat-worker`, and
`ai-workspace-memory-worker`. Before refreshing those images, CodeBuild
reconciles `AiWorkspaceEcsStack` so task-definition and environment changes are
live before the authenticated production smoke. The ordered paths and rollback
procedure are documented in
[`docs/PRODUCTION_DEPLOYMENT.md`](./docs/PRODUCTION_DEPLOYMENT.md).

## Enterprise Readiness

The current stack is ready for POC/pilot work, not yet for broad enterprise
scale. The hosting direction is ECS/Fargate, with App Runner retained only as
temporary rollback during cutover and RDS Proxy/Aurora Postgres evaluated
before broad rollout. The current readiness posture, including dependency audit triage,
health checks, rate limits, redaction/retention, Secrets Manager/KMS/IaC, and
the 1k/10k/100k load-test model, lives in
[`docs/ENTERPRISE_READINESS.md`](./docs/ENTERPRISE_READINESS.md).
