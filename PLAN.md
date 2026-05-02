# AI Hub — Plan v3 (Cursor SDK runtime)

> **What changed from v2.** v2 committed to AWS Bedrock as the runtime, with
> in-process tool functions and MCP servers deferred to week 8+. v3 promotes
> the Cursor SDK to **primary agent runtime** and our app to **enterprise
> shell** — Ping SSO, MCP servers for internal systems, and a recipes/skills
> catalog. Bedrock stays as a **fallback runtime** behind `RUNTIME=bedrock`.
> The seam is sketched on `spike/cursor-sdk-runtime`; see [`SPIKE.md`](./SPIKE.md).
>
> What still holds from v2: product vision, DB schema (with one column
> added), chat UI, multi-model story, permissions model, personal MVP
> deployment story.

## Context

Internal "AI front door" for Georgia-Pacific. Non-technical employees log in once and can do anything they'd want with AI — chat, run workflows against their work data, schedule recurring jobs — without thinking about which tool, which integration, which API. Rob is solo at ~10–15 focused hrs/week. Architecture must let new integrations (Workfront, Databricks, Teams, Graph, GitHub, Salesforce, internal APIs) snap in without re-architecting, but must not pre-pay for that flexibility.

## Architecture in one picture

```
                ┌─────────────────────────────────┐
                │ apps/web (Next.js, Fargate)     │
                │   - Ping OIDC SSO               │
                │   - chat UI / recipes UI        │
                │   - /api/chat → AgentRuntime    │
                │   - persistence (Postgres)      │
                └──────────────┬──────────────────┘
                               │
                   (RUNTIME env: cursor | bedrock)
                               │
                ┌──────────────┴──────────────────┐
                │       AgentRuntime (seam)       │
                └──────┬──────────────────┬───────┘
                       │                  │
        ┌──────────────▼──────────┐   ┌───▼─────────────────┐
        │ CursorRuntime (default) │   │ BedrockRuntime      │
        │  - @cursor/sdk          │   │  - converseStream   │
        │  - durable agents       │   │  - in-process tools │
        │  - MCP servers          │   │  - stateless turns  │
        │  - .cursor/hooks.json   │   │  - fallback only    │
        └────┬────────────────────┘   └─────────────────────┘
             │
   ┌─────────┼─────────┬──────────┬──────────┐
   │         │         │          │          │
┌──▼──┐  ┌──▼──┐  ┌───▼───┐  ┌──▼───┐  ┌────▼────┐
│Graph│  │Teams│  │Workfr.│  │D-brks│  │ future  │
│ MCP │  │ MCP │  │  MCP  │  │ MCP  │  │  ...    │
└─────┘  └─────┘  └───────┘  └──────┘  └─────────┘
```

- **Cursor SDK owns the runtime.** Durable agent state, streaming, tool-use protocol, model selection. We don't reimplement any of it.
- **Our app owns the enterprise shell.** Ping SSO, persistence (chat history, recipes, audit log), the policy layer (`.cursor/hooks.json`), and the MCP servers exposing internal systems.
- **Recipes/skills wrap Cursor agent definitions** — system prompt + locked-down `mcpServers` list + model + params, persisted in our DB.
- **Bedrock stays.** It's the fallback runtime behind `RUNTIME=bedrock`. The existing `runAgentLoop` (PRs #5–#8) is the body of `BedrockRuntime`. No code wasted; both runtimes implement the same `AgentRuntime` interface.

## Core principles

1. **Single runtime seam.** `AgentRuntime` is the only contract `apps/web` knows. `RUNTIME=cursor` and `RUNTIME=bedrock` both produce one. No code path branches on runtime above the seam.
2. **MCP is the integration pattern.** Every external system gets an MCP server (stdio or HTTP). Standard transport, standard tool shape, standard auth seam. No bespoke tool wrappers for each integration.
3. **Recipes are the user-facing primitive.** A recipe is a Cursor agent definition — `{system_prompt, mcp_servers, model, params}`. Business users clone, edit, schedule.
4. **Permissions first-class.** `user_tool_attestations` from day one. The hook layer enforces them.
5. **Multi-model by design.** Haiku for fast/cheap inner loops; Sonnet as default for chat and recipes; Opus for hard reasoning, planning, recipe authoring. Selectable per chat thread and per recipe.
6. **Defer abstractions until a second use case forces them.** Recipe sharing, agent-service split, multi-IdP, mobile — all explicitly deferred.

## Decisions locked

- **Repo:** GitHub-hosted. Spike branch: `spike/cursor-sdk-runtime`.
- **Identity:** PingOne / PingFederate OIDC via Auth.js v5 (custom provider). Hardcoded user week 1 only.
- **Agent runtime (default):** **Cursor SDK** (`@cursor/sdk`, Anysphere). Durable agents, MCP-native, hook-aware.
- **Agent runtime (fallback):** **AWS Bedrock** (`converseStream`, native tool use). Selected via `RUNTIME=bedrock`.
- **Models:** Three Claude models day 1 — **Haiku 4.5**, **Sonnet 4.6** (default), **Opus 4.7**. Logical IDs (e.g. `sonnet-4-6`) map per runtime.
- **Integration model:** **MCP servers** for every external system. Stdio for trusted in-process; HTTP for per-user delegated auth. Graph integration ships as an **MCP server**, not in-process tool functions.
- **Stack:** Next.js (App Router) + TypeScript + Tailwind + Drizzle.
- **Hosting:** AWS-native. Next.js on ECS Fargate behind CloudFront. Existing GP AWS account.
- **Database:** **RDS Postgres** from day one. Aurora Postgres is the upgrade path.
- **v1 hero:** "Chat with your work" — Cursor runtime + Teams MCP server (Entra delegated). Email briefing ships as the first recipe.
- **Kanban:** GitHub Issues + Projects only.

## Refinements carried forward

1. **Auth abstraction shim.** `getCurrentUser(req)` returns the hardcoded user in week 1. Week 2 swaps the implementation only — no API-route churn. ✅ shipped (PR #4).
2. **Tool / model registries on day 1.** Already shipped: `packages/agent/registry.ts` and `packages/agent/models.ts`. They become the **Bedrock-runtime backing store**, plus the model registry is shared by both runtimes.
3. **Runtime seam on day 1 of week 3.** `packages/cursor-runtime/` (sketched in the spike) lands the `AgentRuntime` interface, `BedrockRuntime` adapter, and `CursorRuntime` adapter. `apps/web` switches from calling `runAgentLoop` directly to `getRuntime().runTurn()`.
4. **IT fallback: reorder weeks 3↔4 if Entra approval slips past week 2.** Ship recipes (system prompt + Bedrock-runtime, no MCP) first; bring up Teams MCP the moment IT lands. Weekly cadence stays intact.
5. **Personal MVP deployment.** Same Fargate architecture, cheap-mode wired via Terraform variable `deployment_mode = "personal" | "production"`. ~$60/mo fixed. IT sees production-shape architecture in the demo.

## Working model

- **Rob:** PM. Sets strategy, defines value, signs off Friday demos.
- **Claude (Code/Project):** PO agent. Breaks strategy into structured GitHub Issues. Stand up week 3 once the codebase has real patterns.
- **Cursor:** Dev agent. Reads Issues, implements, opens PRs.
- **Cadence:** Ship something demoable to a skeptical exec every Friday in 5 minutes.

## Roadmap (weekly ships)

### Week 1 — Bedrock end-to-end, hardcoded user ✅
**Shipped:** Login (hardcoded) → chat with Bedrock → streaming responses → threads persist. PRs #1–#8.

This week's output is now the **Bedrock fallback runtime** in v3 — same code, new role.

### Week 2 — Real auth, multi-user
**Ship:** A teammate logs in via Ping; their own chat history.

- PingOne OIDC via Auth.js v5 (custom provider, not the generic preset).
- `users` upsert on first login.
- `getCurrentUser` swaps to session-derived ID. **No API-route changes.**
- Playwright test against Ping dev tenant.

### Week 3 — Cursor SDK runtime + first MCP server (Teams)
**Ship:** "What did Sara message me about the Q3 launch?" returns a real answer, with visible tool calls, running on the Cursor SDK against a Teams MCP server.

- Promote `packages/cursor-runtime/` from spike → main. Install `@cursor/sdk`. Verify CI handles the `sqlite3` native binding.
- Implement `CursorRuntime.runTurn` (replace the spike's throw). Wire `signal`, `usage`, stop reasons through `AgentEvent`.
- Drizzle migration: add `chat_threads.cursor_agent_id text`. Implement `ThreadAgentStore` against the DB (NULL = create-on-next-turn for migrated rows).
- Wire `getRuntime()` into `apps/web/app/api/chat/route.ts` — single edit replacing the direct `runAgentLoop` call.
- Promote `packages/mcp-servers/teams.ts` from stub → real. Stdio transport on the web container. Reuses Entra OAuth code flow + KMS-encrypted per-user tokens (the v2 plan, repurposed). Tools: `list_my_chats`, `search_messages`, `post_message`.
- `.cursor/hooks.json`: first real hook is `postToolUse → audit_log writer`. Locks down the audit story before tools multiply.
- UI: tool calls render as collapsible cards. (Same UX as the v2 plan; the events come from `AgentRuntime`, not `runAgentLoop`.)
- Cap: ≤8 tool-use iterations per turn (enforced via `.cursor/hooks.json`).
- **PO agent stands up this week.**

**Fallback (Entra slipped past week 2):** keep `RUNTIME=bedrock` for week 3, ship recipes table + manual "Run now" against Bedrock-only model calls (no MCP). Promote Cursor + Teams MCP the moment IT lands.

### Week 4 — Graph (Mail/Calendar) MCP server
**Ship:** "What's on my calendar tomorrow, and which mails reference it?" — one agent turn calling two MCP servers.

- Promote a Graph MCP server (Mail + Calendar). Likely a sibling to Teams MCP; share the Entra app registration and the token store.
- Open architectural call: single Graph MCP for all Microsoft surfaces vs. one server per surface. Default to **separate servers** until a real reason to merge appears (audit-log isolation, blast-radius limits).
- Recipe: hardcoded "Morning Briefing" — system prompt + `mcp_servers: [graph, teams]` + Sonnet. "Run now" button on `/recipes`.
- SES integration for outbound mail.
- Full transcript stored in S3 (keeps DB rows small).
- `recipe_runs` table populated.

### Week 5 — Schedule it
**Ship:** Monday 8am, briefing arrives without any user action.

- EventBridge cron per recipe → Fargate scheduled task → recipe execution via `getRuntime().runTurn()` → SES.
- Per-user schedule picker (just the briefing, not generic yet).
- Scheduled runs share the `AgentRuntime` seam — no second code path.

### Week 6 — Recipes / skills catalog
**Ship:** A colleague creates their own recipe without Rob's help.

- `recipes` table + CRUD UI.
- Each recipe row materializes into a Cursor agent definition at runtime: `{system_prompt, mcp_servers, model, params}`.
- Morning Briefing becomes a row — users clone and edit.
- 1–2 starter recipes (e.g., "summarize unread mail since yesterday").
- "Skills" naming TBD vs. "Recipes" — same concept, depending on which language IT/business prefers.

### Week 7 — Tools catalog + attestations
**Ship:** Users see what's available, toggle what they have access to, recipes and chat respect toggles.

- `tools_catalog` table (admin-curated, seedable from YAML). Each tool maps to one MCP server + tool name.
- `user_tool_attestations` table.
- Tools page UI: tiles, attestation toggles, category grouping.
- Auto-detect M365 licenses via Graph `/me/licenseDetails` → mark Teams/Mail/Calendar attestations as `graph_auto`.
- `.cursor/hooks.json` extended: `preToolUse` checks attestation before allowing the call. This is the policy layer paying off.

### Week 8 — Second non-Microsoft integration + admin/audit/hardening
**Ship:** Cross-system recipe works ("search Workfront tasks and email me a summary").

- Pick highest-value second integration: **Workfront** (per-user OAuth) or **Databricks** (service-principal M2M). Promote `packages/mcp-servers/<name>.ts` from stub.
- **Seam test.** First non-Microsoft MCP server validates that the auth-injection pattern (HTTP transport with per-user `Authorization` header, vs. stdio for service-principal cases) holds up.
- Admin pages: catalog CRUD, user list, audit view, MCP-server health.
- Full `audit_log` writes (every MCP tool call, recipe run, admin change) via `postToolUse` hook. JSONL export.
- Threat model doc, CSP, rate limits on `/api/chat`, `zap-baseline`.
- Data retention TTLs, S3 lifecycle.
- Runbook: incident response, backup/restore drill.
- IT/security review.

### Explicitly deferred
Agent service split (extract from Next.js when scheduled jobs cause web latency), recipe sharing/marketplace, role-aware proactive suggestions, multi-IdP support, mobile, sunsetting the Bedrock runtime.

## Data model (Postgres + Drizzle)

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Identity | `id`, `ping_subject` (unique), `email`, `display_name`, `is_admin`, `created_at`, `last_seen_at` |
| `chat_threads` | Chat sessions | `id`, `user_id`, `title`, `default_model_id`, **`cursor_agent_id`** (nullable; populated on first Cursor-runtime turn), `created_at`, `updated_at` |
| `chat_messages` | Messages | `id`, `thread_id`, `role` (user/assistant/tool), `content`, `model_id`, `runtime` (`cursor`/`bedrock`), `tokens_in`, `tokens_out`, `tool_calls` (jsonb), `tool_results` (jsonb), `created_at` |
| `oauth_tokens` | Per-user delegated tokens (Entra/Workfront/etc.), KMS-encrypted | `id`, `user_id`, `provider`, `scope`, `access_token_ciphertext`, `refresh_token_ciphertext`, `iv`, `auth_tag`, `encrypted_dek`, `expires_at`, `needs_reauth`, `updated_at` |
| `mcp_servers` | Admin-curated MCP server registry | `id`, `slug` (unique), `display_name`, `transport` (`stdio`/`http`), `endpoint`, `auth_model` (`delegated`/`m2m`/`none`), `enabled` |
| `tools_catalog` | Admin-curated tools (each maps to one MCP server + tool name) | `id`, `slug`, `mcp_server_id`, `tool_name`, `display_name`, `description`, `icon_url`, `category`, `requires_license`, `auto_detect_method` (enum: `graph_license`, `none`), `enabled`, `sort_order` |
| `user_tool_attestations` | Per-user tool access | `user_id`, `tool_id`, `source` (enum: `self`, `graph_auto`, `admin`), `attested_at`. PK `(user_id, tool_id)` |
| `recipes` | Saved Cursor agent definitions | `id`, `owner_user_id`, `name`, `description`, `system_prompt`, `model_id`, `mcp_server_slugs[]`, `allowed_tools[]`, `schedule_cron`, `params_schema` (jsonb), `visibility` (`private`/`org`) default `private` |
| `recipe_runs` | Execution log | `id`, `recipe_id`, `user_id`, `started_at`, `finished_at`, `status` (`running`/`ok`/`error`), `runtime`, `input_params` (jsonb), `output_summary`, `transcript_s3_key`, `tokens_in`, `tokens_out`, `cost_usd_micros` |
| `audit_log` | Compliance trail | `id`, `user_id`, `action`, `resource_type`, `resource_id`, `metadata` (jsonb), `at` |

**Day-one indexes:** `chat_messages(thread_id, created_at)`, `recipe_runs(user_id, started_at desc)`, `oauth_tokens(user_id, provider)`, `audit_log(user_id, at desc)`, `chat_threads(cursor_agent_id)`.

**v2 → v3 schema deltas:**
- `chat_threads.cursor_agent_id` (nullable, NULL = create-on-next-turn).
- `chat_messages.runtime` (which runtime produced this message — useful for cost analytics across the cutover).
- `recipe_runs.runtime` (same).
- New `mcp_servers` table; `tools_catalog` gains `mcp_server_id` + `tool_name` so each row points to a concrete MCP-tool pair.

## Repo structure

```
apps/
  web/                     Next.js on Fargate; UI + auth + API routes
packages/
  db/                      Drizzle schema + client
  encryption/              KMS envelope helpers
  agent/                   ✅ Tool/model registries + Bedrock loop (the body of BedrockRuntime)
  cursor-runtime/          ✅ AgentRuntime seam, BedrockRuntime + CursorRuntime adapters
    src/
      types.ts             AgentRuntime interface, TurnInput, RuntimeName
      bedrock-runtime.ts   wraps the existing runAgentLoop
      cursor-runtime.ts    @cursor/sdk adapter
      factory.ts           getRuntime() reads RUNTIME env var
  mcp-servers/             one file per system (teams, graph, workfront, databricks, ...)
    src/
      teams.ts             promoted in week 3
      graph.ts             promoted in week 4
      workfront.ts         promoted in week 8
      databricks.ts        promoted in week 8
  auth/
    getCurrentUser.ts      ✅ hardcoded in wk1, session-derived in wk2
    ping-provider.ts       Auth.js custom provider (week 2)
  shared-types/            zod schemas for tools, recipes, agent contracts
  config/                  env parsing with zod
.cursor/
  hooks.json               policy layer: preToolUse (attestation check), postToolUse (audit log)
infra/terraform/           ecs, kms, iam, rds, eventbridge, cloudfront, ses
.github/workflows/         ci, deploy
ARCHITECTURE.md            living doc; updated as decisions evolve
```

## Critical files

- `apps/web/app/api/chat/route.ts` — SSE relay into `getRuntime().runTurn()`. Runtime-agnostic.
- `apps/web/app/(app)/chat/page.tsx` — streaming UI with model selector. ✅ shipped.
- `packages/cursor-runtime/src/types.ts` — the `AgentRuntime` contract (week 3 promotion).
- `packages/cursor-runtime/src/cursor-runtime.ts` — the `@cursor/sdk` adapter (week 3 promotion).
- `packages/cursor-runtime/src/bedrock-runtime.ts` — wraps existing `runAgentLoop`.
- `packages/cursor-runtime/src/factory.ts` — `getRuntime()`.
- `packages/mcp-servers/src/teams.ts` — first real MCP server (week 3).
- `.cursor/hooks.json` — policy layer (audit log in week 3, attestation gate in week 7).
- `packages/auth/getCurrentUser.ts` — ✅ shipped.
- `packages/db/schema.ts` — Drizzle schema. Migration in week 3 adds `cursor_agent_id`, `runtime`, `mcp_servers` table.

## Top risks + mitigations

1. **Cursor SDK is young** (v1.0.12 published 2026-05-01; surface still moving — `Agent.get` is cloud-only, local agent lookup is post-launch). Mitigation: `BedrockRuntime` is the fallback behind `RUNTIME=bedrock`. If Cursor's surface breaks compat, we flip the env var while we adapt.
2. **`@cursor/sdk` install footprint** (12 MB unpacked, `sqlite3` native binding). Mitigation: gate the install on the spike branch until week 3 promotion; verify CI handles the native build before merging to main.
3. **Per-user delegated auth into MCP servers.** `mcpServers[].env` is fixed at process start. Mitigation: HTTP transport with `Authorization` header for delegated cases (Teams, Graph, Workfront); stdio reserved for service-principal/M2M.
4. **PingOne ↔ Auth.js v5 quirks** — custom OIDC provider; integration-test against Ping dev tenant in week 2.
5. **Graph admin/user consent timing** — IT critical path; submitted week 1, smallest scope set; weeks 3↔4 swap fallback if it slips.
6. **Per-user token encryption** — KMS envelope encryption, redacting logger, alarms on `kms:Decrypt` failures.
7. **Cost runaway** — cap `max_tokens`, ≤8 tool-use iterations per turn (enforced via `preToolUse` hook), per-user daily token quotas, CloudWatch alarms at $50 / $200 / $500.
8. **Audit-log discipline depends on hooks firing reliably.** `postToolUse` is the natural audit point. Mitigation: integration test verifying every MCP call lands in `audit_log`; alert on hook-skip.
9. **CloudFront buffering SSE** — confirm `Cache-Control: no-cache` + `X-Accel-Buffering: no` header behavior; fall back to ALB-direct if CloudFront strips SSE.
10. **Burnout / context-switching** — 10–15 focused hrs/week, blocks not scraps. If shipping slips two weeks in a row, reassess scope.

## Personal MVP deployment (for IT demo)

Goal: stand the system up on Rob's personal AWS account so IT can see the production-shape architecture without GP picking up the bill yet. Same Terraform, different variable.

**Topology differences vs. production (`deployment_mode = "personal"`):**

- App in **public subnet** with a public IP — no NAT Gateway. Saves $33–66/mo. App SG locked to ALB.
- **Single-AZ** RDS `db.t4g.micro` (20GB). Single-AZ Fargate.
- **Bedrock prompt caching enabled** for the fallback runtime's system prompt + tool definitions. Cuts input-token cost ~70–90% on repeated turns.
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
| Cursor SDK / Bedrock model spend (light personal use, prompt caching on for Bedrock) | $5–50 |
| **Realistic monthly** | **$65–110** |

Year 1 (free tier covering RDS + CloudFront): subtract ~$15–20/mo.

**Switch to production:** flip `deployment_mode = "production"` → adds NAT in 2 AZs, multi-AZ RDS, autoscaling Fargate. Roughly 2–3× the fixed cost.

## End-to-end verification (week 3 demo — first Cursor + MCP turn)

1. PR → CI green (incl. `sqlite3` native build) → merge → image to ECR → ECS rollout completes <5min → `/health` green.
2. Browser hits CloudFront URL → loads chat page (Ping login round-trip from week 2) → typing "what did Sara message me about Q3?" streams a Cursor SDK response with a visible Teams MCP tool call.
3. Switch model selector to Haiku, send another message → `chat_messages.model_id` reflects the switch; tokens logged; `chat_messages.runtime = 'cursor'`.
4. Set `RUNTIME=bedrock` env var on the task → restart → same chat works against Bedrock fallback. `chat_messages.runtime = 'bedrock'` for new messages. UI/UX identical.
5. Refresh → thread history persisted in RDS; `cursor_agent_id` populated for Cursor-runtime threads.
6. Kill the running ECS task mid-stream → UI shows clean error, not stuck spinner.
7. Audit-log spot check: every Teams MCP tool call has a corresponding `audit_log` row written by the `postToolUse` hook.
8. Curl `/api/chat` with no session → 401.

## Open questions / TBDs

- **Single Graph MCP vs. one server per surface?** Default plan: separate Teams, Mail, Calendar servers. Revisit if duplicate token-refresh logic becomes a maintenance burden.
- **Sunset Bedrock runtime?** Not now. Decide after Cursor has run a real workload for ≥1 month.
- **Cursor cloud vs. local agents.** v1 we run agents locally (in the Fargate container). Cloud-hosted Cursor agents are a future option if durability/scale become issues.
- **Naming: "Recipes" vs. "Skills".** Same concept; pick the term that lands better with the first business-user reviewer.
