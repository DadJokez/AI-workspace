# AI Hub — Plan (current)

> **Last updated: June 2026.** This is the single source of truth for architectural decisions and weekly roadmap. The five user journeys live in [`docs/ROADMAP.md`](./docs/ROADMAP.md); the component design and request flow live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Execution packets: [`specs/001`](./specs/001-runtime-v2-autopilot/) (Runtime V2), [`specs/002`](./specs/002-skills-spine/) (Skills Spine — shipped), [`specs/003`](./specs/003-agentcore-substrate/) (AgentCore substrate — deployed).

## What is this

Internal "AI front door" for Georgia-Pacific. Non-technical employees log in once and can do anything they'd want with AI — chat, run workflows against their work data, schedule recurring jobs — without thinking about which tool, which integration, which API. Rob is solo at ~10–15 focused hrs/week. Architecture must let new integrations (Workfront, Databricks, M365, GitHub, Salesforce, internal APIs) snap in without re-architecting, but must not pre-pay for that flexibility.

AI Hub is intentionally a **thin enterprise wrapper**: one simple front door
plus the governance, audit, token, recipe, schedule, quota, and sharing layers
that make existing platforms usable inside an enterprise. It should not rebuild
Bedrock, M365, Salesforce, Workfront, Databricks, specialized IDEs, or
deployment platforms unless AI Hub needs that layer for control, audit,
portability, or a clear user-experience win.

## Architecture in one picture

```
                ┌─────────────────────────────────┐
                │ apps/web (Next.js container)    │
                │   active target: ECS/Fargate    │
                │   rollback: App Runner          │
                │   - GitHub OAuth (NextAuth v4)  │
                │   - chat UI / admin UI          │
                │   - /api/chat → AgentRuntime    │
                │   - persistence (Postgres)      │
                └──────────────┬──────────────────┘
                               │
                   (RUNTIME env: bedrock | agentcore)
                               │
                ┌──────────────┴──────────────────┐
                │       AgentRuntime (seam)       │
                └──────┬──────────────────┬───────┘
                       │                  │
        ┌──────────────▼──────────┐   ┌───▼─────────────────┐
        │ BedrockRuntime          │   │ AgentCoreRuntime    │
        │  - converseStream       │   │  - durable worker   │
        │  - direct chat          │   │  - session isolated │
        │  - MCP tool turns       │   │  - skills/schedules │
        │  (RUNTIME=bedrock)      │   │  (RUNTIME=agentcore)│
        └────┬────────────────────┘   └──────────┬──────────┘
             │                                   │
   ┌─────────┼─────────┬──────────┬──────────┐
   │         │         │          │          │
┌──▼──┐  ┌──▼──┐  ┌───▼───┐  ┌──▼───┐  ┌────▼────┐
│ GH  │  │Graph│  │Workfr.│  │D-brks│  │ future  │
│ MCP │  │ MCP │  │  MCP  │  │ MCP  │  │  ...    │
│ ✅  │  │ stub│  │ stub  │  │ stub │  │         │
└─────┘  └─────┘  └───────┘  └──────┘  └─────────┘
```

- **June 2026: runtime posture simplified.** Fast chat and interactive tool
  turns run through AWS Bedrock. Durable chat, skills, and scheduled jobs run
  through Amazon Bedrock AgentCore in our AWS account. The product no longer
  depends on the Cursor SDK or Anysphere-hosted execution.
- **AWS owns the runtime substrate.** Streaming, model dispatch, MCP tool
  calls, durable workers, and long-running execution stay inside the Bedrock /
  AgentCore boundary. AI Hub owns durable conversation context in Postgres.
- **Our app owns the enterprise shell.** Auth, persistence (chat history, run
  history, audit log), provider attestations, quota/redaction/retention policy,
  and the MCP integration registry.
- **MCP is the integration pattern.** Every external system gets an MCP server. Standard transport, standard tool shape, standard auth seam. No bespoke tool wrappers per integration.
- **AgentCore is the durable lane.** Both Bedrock and AgentCore implement the
  same `AgentRuntime` interface; the chat route never knows which ran.

## Core principles

1. **Single runtime seam.** `AgentRuntime` is the only contract `apps/web` knows. `RUNTIME=bedrock` and `RUNTIME=agentcore` both produce one. No code path branches on runtime above the seam.
2. **MCP is the integration pattern.** Every external system gets an MCP server. No bespoke tool wrappers.
3. **Skills are the user-facing primitive.** A skill is an agent definition - `{system_prompt, mcp_servers, model, params}`. Business users clone, edit, schedule, and share.
4. **Permissions first-class.** `user_tool_attestations` from day one. Provider-level gates enforce what can be mounted today; tool/category enforcement needs a verified hook path or MCP proxy.
5. **Multi-model by design.** Haiku for fast/cheap inner loops; Sonnet as default; Opus for hard reasoning. Selectable per chat thread and per recipe.
6. **Defer abstractions until a second use case forces them.**

## Decisions locked

| Decision | What shipped |
|---|---|
| **Repo** | GitHub-hosted, monorepo, pnpm workspaces |
| **Identity (POC)** | GitHub OAuth via NextAuth v4. `users.ping_subject` stores the GitHub numeric user ID. Admins set by `role` column in DB. |
| **Identity (enterprise)** | PingOne / PingFederate OIDC. The NextAuth provider swaps; the `users` table and `getSessionUser()` helper do not change. `ping_subject` will hold the PingOne subject claim as originally intended. |
| **Agent runtime (default)** | **AWS Bedrock** (`converseStream` plus MCP client). Selected via `RUNTIME=bedrock`. Fast chat and interactive tool turns run here. Thread continuity comes from AI Hub's bounded context layer: summary schema/helper + budgeted recent messages. Summary generation itself is still pending. |
| **Agent runtime (durable)** | **Amazon Bedrock AgentCore Runtime**. Selected via `RUNTIME=agentcore` for worker lanes: durable chat, skills, scheduled jobs, and future app-build jobs. |
| **Models** | Three Claude models — **Haiku 4.5**, **Sonnet 4.6** (default), **Opus 4.7**. Logical IDs map per runtime. |
| **Integration model** | **MCP servers** for every external system. HTTP for per-user delegated auth. GitHub MCP is live; others stubbed. |
| **Stack** | Next.js 15 (App Router) + TypeScript + Tailwind + Drizzle |
| **Hosting** | **ECS on Fargate** is the active deployment target, managed by CDK TypeScript with an ALB, Route 53, Secrets Manager, CloudWatch logs, and separate web/chat-worker/memory-worker services. App Runner remains temporary rollback during cutover. CodeBuild builds images, runs migrations from the production secret, pushes to ECR, and forces ECS deployments. |
| **Database** | **RDS Postgres** via Drizzle. Migrations in `packages/db/drizzle/`. |
| **First working integration** | GitHub MCP — per-user, HTTP transport, tokens stored in `oauth_tokens`, accessed via `api.githubcopilot.com/mcp/` |
| **User-facing primitive** | **Skills** (naming decided June 2026; supersedes "recipes"). `skills` table + catalog at `/skills`: create, run, clone, schedule, share. The run ledger is `runs` (renamed from `recipe_runs`). |
| **Agent substrate (worker lanes)** | **Bedrock AgentCore Runtime** (`RUNTIME=agentcore`) — durable chat, skill, and scheduled runs execute session-isolated in our AWS account (`specs/003`). Sonnet + Haiku enabled on Bedrock; Opus 4.7 is account-gated by AWS. |
| **Thin apps (J4 slice)** | `apps` registry over workspace artifacts, served SSO-gated at `/apps/{slug}` with a restrictive CSP; deploy/revert over artifact versions; no-secrets scan at save. |

## Working model

- **Rob:** PM. Sets strategy, defines value, signs off Friday demos.
- **Claude (Cowork/Code):** Dev + PO agent. Breaks strategy into GitHub Issues, implements, opens PRs.
- **Cadence:** Ship something demoable to a skeptical exec every Friday in 5 minutes.

## Current state (June 2026)

### What's live in production

Runtime V2 is now tracked as a Spec Kit-style packet at
[`specs/001-runtime-v2-autopilot`](./specs/001-runtime-v2-autopilot/). The
packet is the execution source for production rollout, autopilot routing polish,
model fallback, metrics, and shared-rate-limit follow-up work.

| Feature | Status |
|---|---|
| Chat (multi-turn, streamed, persisted per user) | ✅ |
| Thread sidebar (history, recency grouping, rename, delete) | ✅ |
| Model selector (Haiku / Sonnet / Opus) | ✅ |
| GitHub OAuth sign-in / sign-out | ✅ |
| Middleware (unauthenticated → /login, non-admin → /chat) | ✅ |
| Admin panel (users, invitations) | ✅ |
| Invitations (admin sends, user redeems on first login) | ✅ |
| Theme (light/dark), settings panel | ✅ |
| Bedrock runtime (default via `RUNTIME=bedrock`) | ✅ |
| AgentCore runtime (`RUNTIME=agentcore`) live for worker lanes | ✅ |
| GitHub MCP per-user (OAuth flow + token vault + live calls) | ✅ |
| AWS App Runner + CodeBuild CI/CD for pilot | ✅ rollback only |
| ECS/Fargate CDK hosting target | ✅ |
| Prompt/context guardrails + summary schema/helper | ✅ |
| Safe closed-stream handling for long turns | ✅ |
| Agent activity timeline for chat tool calls/results | ✅ |
| Developer Briefing execution route (manual GitHub workflow) | ✅ |
| Vault memory capture queue + approval UI | ✅ |
| DB/runtime health checks | ✅ pilot |
| Request/body limits and process-local rate limits | ✅ pilot |
| Enterprise readiness decision record | ✅ |
| Skills: create / run / clone / edit / archive through the shared worker pipeline | ✅ |
| Schedules: leased scheduler tick, timezone-safe cadences, history | ✅ |
| Sharing: skills + apps to named teammates (recipient credentials only) | ✅ |
| Thin apps: registry, SSO-gated `/apps/{slug}` serving, versions, revert | ✅ |
| MCP client in the Bedrock loop (tool turns without Anysphere) | ✅ |
| Collapsible work receipts in chat | ✅ |
| First-run welcome tour + Settings replay | ✅ |
| Slash-command skill palette in chat ("/" runs skills) | ✅ |
| 7 starter skills (2 GitHub + 5 corporate zero-provider) | ✅ |
| CI runs the full test suite (189 tests) | ✅ |
| Rolling summary generation (#771: stale tool-result clearing + `thread-summary.v1` carry-over) | ✅ |
| Shared quota store and daily token budgets | ❌ pending |
| Dependency audit full clean state | ❌ upstream/transitive pending |

### What's in the DB schema

| Table | Status |
|---|---|
| `users` | ✅ |
| `chat_threads` (with `cursor_agent_id`, `summary`, `summary_updated_at`) | ✅ |
| `chat_messages` | ✅ |
| `oauth_tokens` (AES-256-GCM encrypted, per-user) | ✅ |
| `invitations` | ✅ |
| `memory_capture_queue` | ✅ |
| `user_memory_items` | ✅ |
| `audit_log` | ✅ schema + MCP tool/skill/schedule/share/app writes |
| `tools_catalog` | ✅ |
| `user_tool_attestations` | ✅ |
| `mcp_servers` | ✅ |
| `skills` | ✅ (the user-facing primitive; supersedes the planned `recipes`) |
| `schedules` | ✅ leased cadence rows |
| `shares` | ✅ generic skill/app grants |
| `apps` | ✅ thin-app registry over workspace artifacts |
| `runs` | ✅ (renamed from `recipe_runs`; ledger for chat/skill/scheduled/workflow) |
| `users.tour_completed_at` | ✅ first-run tour gate |
| `users.assistant_name` | ✅ named assistant (onboarding wizard, specs/005) |

## Roadmap (weekly ships)

### ✅ Weeks 1–3 — Foundation

**Shipped:** Login → chat → streaming → threads persist → Bedrock runtime → GitHub OAuth + MCP → admin panel → invitations.

All code is on `main`. PRs #1–#22 merged. Only `origin/main` on remote.

### Week 4 — Graph (Mail / Calendar) MCP server

**Ship:** "What's on my calendar tomorrow, and which mails reference it?" — one agent turn calling two MCP servers.

- Add the Microsoft Graph MCP server for Mail + Calendar. Share the Entra app registration and the token store pattern already proven with GitHub MCP.
- Recipe: hardcoded "Morning Briefing" — system prompt + `mcp_servers: [graph-mail, graph-cal]` + Sonnet.
- Use the new `recipe_runs` table for the hardcoded "Morning Briefing" execution log.
- SES integration for outbound mail (briefing delivery).

**Note:** This requires Entra / M365 app registration approval from GP IT. If IT is delayed, swap in another Tier 1 integration (Salesforce OAuth, or Workfront) and come back to Graph.

### ✅ Week 5 — Schedule it (shipped June 2026 as Schedules)

**Shipped:** `schedules` table + leased scheduler tick inside the chat-run worker; timezone-safe cadences; runs land in designated threads through the same `AgentRuntime` seam. Remaining from the original scope: SES email delivery (tracked on #27).

### ✅ Week 6 — Recipes catalog (shipped June 2026 as Skills)

**Shipped:** `skills` table + catalog at `/skills` (create, run, clone, edit, archive), starter pack of 7, slash-command palette in chat, sharing to named teammates. See `specs/002-skills-spine`.

Original scope notes kept below for traceability:

**Ship:** A colleague creates their own recipe without Rob's help.

- `recipes` table + CRUD UI at `/recipes`.
- Each recipe row materializes into an agent definition at runtime.
- Developer Briefing and Morning Briefing become rows. Users clone and edit.
- Reuse the chat activity timeline component for recipe run details by reading
  `recipe_runs.outputs.toolCalls/toolResults`.
- 2–3 starter recipes (Morning Briefing, Weekly Status stub, etc.).
- Port `ai-intake` as Recipe 001 — proving the catalog can absorb an existing production use case.

### Week 7 — Tools catalog + attestations

**Ship:** Users see what's available, toggle what they have access to; recipes and chat respect toggles.

- Use the new `tools_catalog` table for admin-curated provider/tool entries.
- Use the new `user_tool_attestations` table for per-user provider/category/tool grants.
- Tools page UI: tiles, attestation toggles, category grouping.
- Tool gate checks provider attestations before MCP servers are mounted for the turn.

### Week 8 — Second non-Microsoft integration + admin / audit hardening

**Ship:** Cross-system recipe works ("search Workfront tasks and email me a summary").

- Promote `packages/mcp-servers/src/workfront.ts` or `databricks.ts` from stub → real. Picks whichever GP IT / GP data team clears first.
- Expand `audit_log` writes from MCP tool calls to recipe runs and admin changes.
- Admin pages: catalog CRUD, user list, audit view, MCP-server health.
- Threat model doc, CSP, rate limits on `/api/chat`.

### Explicitly deferred

Agent Wire (S3/Athena telemetry), Salesforce MCP, ServiceNow MCP, GitHub/ADO code-platform MCP, SAP ERP, J4 App Build + Deploy, J5 Share, recipe sharing/marketplace, mobile, multi-IdP, sunsetting Bedrock runtime.

## Data model (Postgres + Drizzle)

### Tables shipped

| Table | Key columns |
|---|---|
| `users` | `id` (uuid), `ping_subject` (GitHub numeric user ID, unique), `email`, `display_name`, `role` (`user`/`admin`), `created_at` |
| `chat_threads` | `id`, `user_id`, `title`, `default_model_id`, `cursor_agent_id` (nullable), `mcp_signature`, `summary`, `summary_updated_at`, `created_at`, `updated_at` |
| `chat_messages` | `id`, `thread_id`, `role`, `content`, `model_id`, `runtime`, `tokens_in`, `tokens_out`, `tool_calls` (jsonb, powers visible activity), `tool_results` (jsonb, powers visible activity), `created_at` |
| `oauth_tokens` | `id`, `user_id`, `provider`, `access_token`, `refresh_token`, `expires_at`, `scope`, `created_at`, `updated_at` |
| `invitations` | `id`, `email`, `token`, `invited_by`, `redeemed_at`, `created_at` |
| `recipe_runs` | `id`, `user_id`, `recipe_id` (nullable), `recipe_slug`, `thread_id`, `trigger_type`, `status`, `runtime`, `model_id`, `inputs`, `outputs`, `error`, `started_at`, `completed_at`, `created_at`, `updated_at` |
| `audit_log` | `id`, `actor_user_id`, `action_type`, `status`, `provider`, `tool_name`, `tool_call_id`, `chat_thread_id`, `chat_message_id`, `recipe_run_id`, `input`, `output`, `error`, `metadata`, `started_at`, `completed_at`, `created_at` |
| `mcp_servers` | `id`, `slug`, `display_name`, `description`, `transport`, `status`, `endpoint_url`, `auth_mode`, `metadata`, `created_at`, `updated_at` |
| `tools_catalog` | `id`, `mcp_server_id`, `provider`, `tool_name`, `display_name`, `description`, `category`, `action`, `requires_attestation`, `enabled`, `metadata`, `created_at`, `updated_at` |
| `user_tool_attestations` | `id`, `user_id`, `scope_type`, `provider`, `category`, `tool_catalog_id`, `tool_name`, `action`, `approved_at`, `approved_by`, `revoked_at`, `revoked_by`, `reason`, `metadata`, `created_at`, `updated_at` |

### Tables to add

| Table | When | Purpose |
|---|---|---|
| `recipes` | Week 6 | Saved agent definitions |

## Auth model

### POC (personal environment — current)

```
Layer 1: User → Shell          (GitHub OAuth via NextAuth v4, JWT session)
Layer 2: Shell → GitHub MCP    (per-user GitHub OAuth tokens in oauth_tokens, refreshed per-turn)
```

`session.user.id` is the canonical `users.id` UUID. `users.ping_subject` holds the GitHub numeric user ID. The column name is intentional — it maps to the enterprise subject claim when PingOne replaces GitHub OAuth.

### Enterprise (future — required before GP production)

```
Layer 1: User → Shell          (PingOne / PingFederate OIDC, ~8h session)
Layer 2: Shell → MCP servers   (per-user delegated tokens per integration)
```

The swap is a **NextAuth provider change only** — `users` table, `getSessionUser()`, all API routes, and the `ping_subject` column name stay exactly as-is. PingOne issues a subject claim; it lands in `ping_subject` as originally designed. No migration needed.

For all MCP integrations (GitHub, M365, Salesforce, Workfront):
- Same `oauth_tokens` table, different `provider` value per system.
- HTTP MCP transport with short-lived Bearer tokens injected per-turn.
- Tool gate checks `user_tool_attestations` before MCP providers are mounted.

## Repo structure

```
apps/
  web/                     Next.js container; ECS/Fargate web service, App Runner rollback
packages/
  db/                      Drizzle schema + client + migrations
  agent/                   Tool/model registries + Bedrock loop
  agent-runtime/          AgentRuntime seam
    src/
      types.ts             AgentRuntime interface, TurnInput, RuntimeName
      bedrock-runtime.ts   Wraps the existing runAgentLoop
      agentcore-runtime.ts Amazon Bedrock AgentCore adapter
      factory.ts           getRuntime() - defaults to 'bedrock'
  mcp-servers/
    src/
      teams.ts             stub — Week 8
      workfront.ts         stub — Week 8
      databricks.ts        stub — Week 8
      # GitHub MCP is remote: https://api.githubcopilot.com/mcp/
      # mounted by apps/web/lib/oauth/mcp-servers.ts
.github/workflows/         ci.yml (lint + typecheck + build)
docs/
  ARCHITECTURE.md          Component design, request flow, auth layers
  ROADMAP.md               Five journeys, integration tiers, flagship use cases
```

## Critical files

- `apps/web/app/api/chat/route.ts` — SSE relay into `getRuntime().runTurn()`. Runtime-agnostic.
- `apps/web/app/api/workflows/developer-briefing/run/route.ts` — Manual GitHub MCP workflow execution, persisted in `recipe_runs`.
- `apps/web/middleware.ts` — Unauthenticated → `/login`; non-admin on `/admin` → `/chat`.
- `apps/web/lib/auth/getSessionUser.ts` — Canonical user lookup: `WHERE id = session.user.id`.
- `packages/agent-runtime/src/factory.ts` - `getRuntime()` defaults to `'bedrock'`.
- `packages/agent-runtime/src/agentcore-runtime.ts` - AgentCore worker adapter.
- `packages/db/src/schema.ts` — Drizzle schema.

## Top risks

1. **AgentCore maturity and quotas** - worker lanes now depend on AgentCore availability, session behavior, IAM posture, and Bedrock model access. Keep runtime smoke tests and clear fallback language.
2. **Per-user delegated auth at MCP scale** - the pattern (HTTP transport + per-turn Bearer tokens) is proven with GitHub. Will it hold for Graph's token-refresh frequency when scheduling kicks in? Decide before week 5.
3. **M365 Entra app registration timing** - IT critical path for Graph MCP. Have a ready fallback (Salesforce or Workfront OAuth) if approval slips past week 4.
4. **Cost runaway** - context-size guardrails and process-local request limits are in place for chat turns. Still add `max_tokens`, tool-use iteration caps, shared per-user daily token quotas, and CloudWatch alarms at $50 / $200 / $500.
5. **Audit-log discipline** - MCP tool calls now land in `audit_log`, and the first redaction/retention policy is documented. Recipe-run/admin-action producers and a shared log-redaction helper still need to be wired before week 8 hardening.
6. **Dependency audit debt** - direct patches reduced the audit surface, but `pnpm audit --prod` can still report transitive findings through framework/tooling paths. Track and recheck before IT review.
7. **Hosting migration** — ECS/Fargate is now the active target. The fast cutover uses the existing RDS database first; hardening still needs the RDS Proxy/Aurora posture, shared rate limiting, and private networking decisions.
8. **Burnout** — 10–15 focused hrs/week, blocks not scraps. If shipping slips two weeks in a row, reassess scope.

## Open questions

- **Single Graph MCP vs. one server per surface?** Default: separate mail + calendar servers. Revisit if duplicate token-refresh logic becomes a maintenance burden.
- ~~**Recipes vs. Skills naming.**~~ **Resolved June 2026: Skills.** Schema, URLs, and UI all say skills; the run ledger is `runs`.
- ~~**Sunset Bedrock runtime?**~~ **Resolved June 2026:** Bedrock/AgentCore is the governed runtime stack. The Cursor SDK was removed from the product runtime; users can still use the Cursor desktop app outside Comparative for hardcore development work.
- **ECS hardening timing.** The cutover stack uses current RDS and simple ECS services first. Decide when to add RDS Proxy/Aurora, shared quotas, WAF rules, and private networking before broad pilot traffic.
