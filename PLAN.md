# AI Hub — Plan v2 (final)

## Context

Internal "AI front door" for Georgia-Pacific. Non-technical employees log in once and can do anything they'd want with AI — chat, run workflows against their work data, schedule recurring jobs — without thinking about which tool, which integration, which API. The repo (`/home/user/AI-workspace`) is empty. Rob is solo at ~10–15 focused hrs/week. Architecture must let new integrations (Graph, Databricks, GitHub, Salesforce, internal APIs) snap in without re-architecting, but must not pre-pay for that flexibility.

## Core principles

1. **Standard tool shape.** Every tool is `{name, description, input_schema, handler}`. Bedrock doesn't care about the source; neither does the rest of the system.
2. **Recipes are the user-facing primitive.** `{system_prompt, allowed_tools, params}`. Business users clone, edit, schedule.
3. **Permissions first-class.** `user_tool_attestations` from day one.
4. **Multi-model by design.** Haiku for fast/cheap inner loops and simple tasks; Sonnet as default for chat and recipes; Opus for hard reasoning, planning, recipe authoring. Selectable per chat thread and per recipe. Right tool for the job — cost-conscious story for IT.
5. **Defer every abstraction until a second use case forces it.** No MCP, no agent-service split, no recipe sharing until a concrete second integration or real incident demands it.

## Decisions locked

- **Repo:** `/home/user/AI-workspace`, GitHub-hosted. Branch `claude/planning-architecture-Vudqw`.
- **Identity:** PingOne / PingFederate OIDC via Auth.js v5 (custom provider). Hardcoded user week 1 only.
- **LLM:** AWS Bedrock (`converseStream`, native tool use). Three Claude models enabled day 1: **Haiku 4.5**, **Sonnet 4.6** (default), **Opus 4.7**.
- **Stack:** Next.js (App Router) + TypeScript + Tailwind + Drizzle (ORM library, not a service).
- **Hosting:** AWS-native. Next.js on ECS Fargate behind CloudFront. Existing GP AWS account.
- **Database:** **RDS Postgres** from day one (AWS-managed Postgres). Aurora Postgres is the upgrade path if usage grows.
- **Integration model:** Plain in-process tool functions for v1. **No MCP servers until week 8+** when a second integration creates real pull for a service boundary.
- **Agent loop:** Inside Next.js API routes on Fargate. **No separate agent service** until scheduled jobs cause measurable web latency. Code lives in `packages/agent` so extraction is mechanical.
- **v1 hero:** "Chat with your work" — Bedrock + Microsoft Graph (mail/calendar/files). Email briefing ships as the first recipe.
- **Kanban:** GitHub Issues + Projects only. No `TASKS.md`.

## Refinements added to v2

1. **Auth abstraction shim in week 1.** Ship `getCurrentUser(req)` returning the hardcoded user. Week 2 swaps the implementation only — no API-route churn.
2. **Tool registry on day 1, even with zero tools.** `packages/agent/registry.ts` defines the `Tool` type and `runAgentLoop({ tools, messages })` signature. Week 3's Graph tools register against it. This is the abstraction the "no MCP" decision rests on.
3. **Model registry on day 1.** `packages/agent/models.ts` exports the three Bedrock model IDs with metadata (cost per 1M in/out tokens, supports tool use, recommended use). Chat UI exposes a model selector; default = Sonnet. Per-message `model_id` persisted for cost analytics.
4. **IT fallback: reorder weeks 3↔4 if Entra approval slips past week 2.** Ship recipes (system prompt + Bedrock-only) first, then add Graph as the integration that proves the tool registry. Weekly cadence stays intact.
5. **Personal MVP deployment variant.** Same Fargate architecture as production, but cheap-mode wired via Terraform variable `deployment_mode = "personal" | "production"`. Personal: no NAT, public subnet for app, single-AZ RDS `db.t4g.micro`, ALB, Bedrock prompt caching on. ~$60/mo fixed + Bedrock. IT sees production-shape architecture in the demo.

## Working model

- **Rob:** PM. Sets strategy, defines value, signs off Friday demos.
- **Claude (Code/Project):** PO agent. Breaks strategy into structured GitHub Issues using a feature template. **Stand up week 3** once the codebase has real patterns to learn from.
- **Cursor:** Dev agent. Reads Issues, implements, opens PRs.
- **Cadence:** Ship something demoable to a skeptical exec every Friday in 5 minutes.

## Roadmap (weekly ships)

### Week 1 — Bedrock end-to-end, hardcoded user
**Ship:** Login (hardcoded) → chat with Bedrock → streaming responses → threads persist across sessions.

- Repo bootstrap: Next.js (App Router, TS, Tailwind, Drizzle), Dockerfile, pnpm workspace.
- Terraform: ECR, Fargate cluster, ALB, RDS Postgres (private subnet), CloudFront, IAM roles for Bedrock + Secrets Manager.
- GitHub Actions: lint/test/typecheck on PR; deploy to Fargate on merge via OIDC role.
- DB tables (Drizzle): `users`, `chat_threads` (with `default_model_id`), `chat_messages` (with `model_id` per assistant message).
- `packages/agent/registry.ts` — `Tool` type + `runAgentLoop({ tools, messages, modelId })`. Empty registry, but signature locked.
- `packages/agent/models.ts` — `MODELS` object: Haiku 4.5, Sonnet 4.6, Opus 4.7 with metadata (cost per 1M in/out, tool-use support, blurb).
- `packages/auth/getCurrentUser.ts` — returns env-var hardcoded user in week 1.
- `/api/chat` route → `runAgentLoop()` → `bedrock.converseStream` → SSE to browser. Accepts `modelId` from request body.
- Chat page: message list, input, send, streaming UI, markdown rendering, **model selector dropdown** (Haiku/Sonnet/Opus, default Sonnet).
- **In parallel:** submit Entra app registration to IT for delegated Graph scopes (`Mail.Read`, `Calendars.Read`, `Files.Read`, `User.Read`, `offline_access`). Critical path for week 3.

**Daily:** Mon infra+skeleton; Tue–Wed DB+Bedrock streaming; Thu chat UI; Fri integration+polish+ship.

**Verification (Friday demo):**
1. Hardcoded auth round-trip; user persists in DB.
2. Chat round-trip: SSE first chunk <2s, full transcript persisted.
3. Refresh page → thread history intact.
4. Bedrock throttle → retry once → friendly error. DB down → `/health` 503.
5. PR → CI green → merge → ECS rollout <5min → `/health` green.
6. Security smoke: HSTS, secure cookies, no secrets in client bundle, `npm audit --audit-level=high` clean.
7. Entra app registration submitted to IT.

### Week 2 — Real auth, multi-user
**Ship:** A teammate logs in via Ping; their own chat history.

- PingOne OIDC via Auth.js v5 (custom provider, not the generic preset).
- `users` upsert on first login.
- `getCurrentUser` swaps to session-derived ID. **No API-route changes.**
- Playwright test against Ping dev tenant.

### Week 3 — Graph integration as plain tool functions *(or: recipes-first if IT slipped)*
**Ship (default path):** "What's on my calendar tomorrow?" returns a real answer with visible tool calls.

- Entra OAuth code flow via MSAL Node — separate from Ping/Auth.js. Two flows, two consents, two audit trails.
- KMS envelope encryption for per-user Graph tokens. `oauth_tokens` table.
- Token refresh worker (refresh anything <5min from expiry).
- Tools: `search_mail`, `list_calendar_events`, `get_message`. Plain functions registered via the week-1 registry.
- Bedrock tool-use loop in `runAgentLoop` — agent calls tools, results feed back.
- UI: tool calls render as collapsible cards.
- Cap: ≤8 tool-use iterations per turn.
- **PO agent stands up this week.** Reads existing repo → established patterns become its context.

**Fallback (Entra approval slipped past week 2):** swap weeks 3↔4. Ship recipes table + manual "Run now" button against Bedrock-only tools (no Graph). Graph slots in the moment IT lands.

### Week 4 — Email briefing, manual trigger
**Ship:** Click button → 30s later, briefing email arrives via SES.

- Hardcoded "Morning Briefing" recipe (system prompt + tool whitelist).
- "Run now" button on `/recipes`.
- SES integration.
- Full transcript stored in S3 (keeps DB rows small).
- `recipe_runs` table: started_at, finished_at, status, tokens_in, tokens_out, cost_usd_micros.

### Week 5 — Schedule it
**Ship:** Monday 8am, briefing arrives without any user action.

- EventBridge cron per recipe → Fargate scheduled task → recipe execution → SES.
- Per-user schedule picker (just the briefing, not generic yet).

### Week 6 — Recipes as a real concept
**Ship:** A colleague creates their own recipe without Rob's help.

- `recipes` table + CRUD UI.
- Morning Briefing becomes a row — users clone and edit.
- 1–2 starter recipes (e.g., "summarize unread mail since yesterday").
- Run path: same `runAgentLoop`, seeded with `recipe.system_prompt` + `allowed_tools` filter.

### Week 7 — Tools catalog + attestations
**Ship:** Users see what's available, toggle what they have access to, chat respects toggles.

- `tools_catalog` table (admin-curated, seedable from YAML).
- `user_tool_attestations` table.
- Tools page UI: tiles, attestation toggles, category grouping.
- Auto-detect M365 licenses via Graph `/me/licenseDetails` → mark attestations as `graph_auto`.

### Week 8+ — Second integration + admin/audit/hardening
**Ship:** Cross-system recipe works ("search docs and email me a summary").

- Pick highest-value second integration (Databricks or GitHub).
- **Seam test.** If the second integration reveals patterns that hurt, refactor while small.
- **Possibly extract MCP** here if the second integration's auth model is meaningfully different from Graph's. Otherwise stay plain functions.
- Admin pages: catalog CRUD, user list, audit view, Graph health.
- Full `audit_log` writes (every Graph call, recipe run, admin change). JSONL export.
- Threat model doc, CSP, rate limits on `/api/chat`, `zap-baseline`.
- Data retention TTLs, S3 lifecycle.
- Runbook: incident response, backup/restore drill.
- IT/security review.

### Explicitly deferred
MCP server architecture, agent service split, recipe sharing/marketplace, role-aware proactive suggestions, multi-IdP support, mobile.

## Data model (Postgres + Drizzle)

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Identity | `id`, `ping_subject` (unique), `email`, `display_name`, `is_admin`, `created_at`, `last_seen_at` |
| `chat_threads` | Chat sessions | `id`, `user_id`, `title`, `default_model_id`, `created_at`, `updated_at` |
| `chat_messages` | Messages | `id`, `thread_id`, `role` (user/assistant/tool), `content`, `model_id` (which model produced this assistant message), `tokens_in`, `tokens_out`, `tool_calls` (jsonb), `tool_results` (jsonb), `created_at` |
| `oauth_tokens` | Per-user Graph tokens, KMS-encrypted | `id`, `user_id`, `provider` (`entra`), `scope`, `access_token_ciphertext`, `refresh_token_ciphertext`, `iv`, `auth_tag`, `encrypted_dek`, `expires_at`, `needs_reauth`, `updated_at` |
| `tools_catalog` | Admin-curated tools | `id`, `slug` (unique), `display_name`, `description`, `icon_url`, `category`, `requires_license`, `auto_detect_method` (enum: `graph_license`, `none`), `enabled`, `sort_order` |
| `user_tool_attestations` | Per-user tool access | `user_id`, `tool_id`, `source` (enum: `self`, `graph_auto`, `admin`), `attested_at`. PK `(user_id, tool_id)` |
| `recipes` | Saved workflows | `id`, `owner_user_id`, `name`, `description`, `system_prompt`, `model_id`, `allowed_tools[]`, `schedule_cron`, `params_schema` (jsonb), `visibility` (`private`/`org`) default `private` |
| `recipe_runs` | Execution log | `id`, `recipe_id`, `user_id`, `started_at`, `finished_at`, `status` (`running`/`ok`/`error`), `input_params` (jsonb), `output_summary`, `transcript_s3_key`, `tokens_in`, `tokens_out`, `cost_usd_micros` |
| `audit_log` | Compliance trail | `id`, `user_id`, `action`, `resource_type`, `resource_id`, `metadata` (jsonb), `at` |

**Day-one indexes:** `chat_messages(thread_id, created_at)`, `recipe_runs(user_id, started_at desc)`, `oauth_tokens(user_id, provider)`, `audit_log(user_id, at desc)`.

## Repo structure

```
apps/
  web/                     Next.js on Fargate; UI + auth + API routes (incl. agent loop)
packages/
  db/                      Drizzle schema + client
  encryption/              KMS envelope helpers
  agent/                   Bedrock loop + tool/model registries (extraction-ready)
    registry.ts            Tool type + runAgentLoop signature (week 1)
    models.ts              MODELS map: Haiku/Sonnet/Opus + metadata (week 1)
    bedrock.ts             converseStream + tool-use orchestration
  auth/
    getCurrentUser.ts      hardcoded in wk1, session-derived in wk2
    ping-provider.ts       Auth.js custom provider (week 2)
  tools/                   Tool implementations (graph in wk3, then databricks/github)
  shared-types/            zod schemas for tools, recipes, agent contracts
  config/                  env parsing with zod
infra/terraform/           ecs, kms, iam, rds, eventbridge, cloudfront, ses
.github/workflows/         ci, deploy
ARCHITECTURE.md            living doc; updated as decisions evolve
```

## Critical files to be written

- `apps/web/app/api/chat/route.ts` — SSE relay into `runAgentLoop`, accepts `modelId`.
- `apps/web/app/(app)/chat/page.tsx` — streaming UI with model selector.
- `packages/agent/registry.ts` — `Tool` type, `ToolRegistry`, `runAgentLoop({ tools, messages, modelId })`.
- `packages/agent/models.ts` — `MODELS` map (Haiku/Sonnet/Opus + cost/tool-support metadata), `DEFAULT_MODEL_ID`.
- `packages/agent/bedrock.ts` — `converseStream` + tool-use orchestrator.
- `packages/auth/getCurrentUser.ts` — week 1 shim, week 2 real.
- `packages/db/schema.ts` — Drizzle schema, week-1 tables only.
- `infra/terraform/main.tf` (+ `ecs.tf`, `rds.tf`, `iam.tf`, `cloudfront.tf`).
- `.github/workflows/ci.yml`, `.github/workflows/deploy-web.yml`.

## Top risks + mitigations

1. **PingOne ↔ Auth.js v5 quirks** — custom OIDC provider; integration-test against Ping dev tenant in week 2.
2. **Graph admin/user consent timing** — IT critical path; submitted week 1 with smallest scope set; weeks 3↔4 swap fallback if it slips.
3. **Bedrock model availability/region** — pick region with both Bedrock + data residency; `model_id` abstracted on recipes.
4. **Per-user token encryption** — KMS envelope encryption, redacting logger, alarms on `kms:Decrypt` failures.
5. **Cost runaway** — cap `max_tokens`, ≤8 tool-use iterations per turn, per-user daily token quotas, CloudWatch alarms at $50 / $200 / $500.
6. **Burnout / context-switching** — 10–15 focused hrs/week, blocks not scraps. If shipping slips two weeks in a row, reassess scope.
7. **PO agent generates incoherent tickets early** — defer to week 3 once codebase has real patterns to learn from.
8. **CloudFront buffering SSE in week 1** — confirm `Cache-Control: no-cache` + `X-Accel-Buffering: no` header behavior; fall back to ALB-direct if CloudFront strips SSE.

## Personal MVP deployment (for IT demo)

Goal: stand the system up on Rob's personal AWS account so IT can see the production-shape architecture without GP picking up the bill yet. Same Terraform, different variable.

**Topology differences vs. production (`deployment_mode = "personal"`):**

- App in **public subnet** with a public IP — no NAT Gateway. Saves $33–66/mo. App SG locked to ALB.
- **Single-AZ** RDS `db.t4g.micro` (20GB). Single-AZ Fargate.
- **Bedrock prompt caching enabled** for system prompt + tool definitions. Cuts input-token cost ~70–90% on repeated turns.
- **Stoppable Fargate task** — script to scale to 0 when not demoing.
- AWS Free Tier (year 1) covers RDS, CloudFront, ECR, most S3.

**Expected monthly cost (personal mode, after free tier):**

| Component | Cost |
|---|---|
| ALB | ~$17 |
| Fargate (1 task, 24/7 — halve if you stop it nightly) | ~$18 |
| RDS `db.t4g.micro` single-AZ | ~$15 |
| CloudFront / ECR / KMS / Secrets Manager / S3 | ~$10 |
| **Fixed total** | **~$60/mo** |
| Bedrock (light personal use, ~50–500K tokens/day, prompt caching on) | $5–50 |
| **Realistic monthly** | **$65–110** |

Year 1 (free tier covering RDS + CloudFront): subtract ~$15–20/mo.

**Switch to production:** flip `deployment_mode = "production"` → adds NAT in 2 AZs, multi-AZ RDS, autoscaling Fargate. Roughly 2–3× the fixed cost.

## End-to-end verification (week 1 demo)

1. `terraform apply` provisions everything cleanly in a fresh AWS account/region.
2. PR → CI green → merge → image to ECR → ECS rollout completes <5min → `/health` green.
3. Browser hits CloudFront URL → loads chat page → typing "say hi in 5 words" streams a Bedrock response (first chunk <2s).
4. Switch model selector to Haiku, send another message → streams from Haiku; `chat_messages.model_id` reflects the switch; tokens logged.
5. Refresh → thread history persisted in RDS.
6. Curl `/api/chat` directly with no session → 401.
7. Kill the running ECS task mid-stream → UI shows clean error, not stuck spinner.
8. Confirm Entra app registration ticket is open with IT.
