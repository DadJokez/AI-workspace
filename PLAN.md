# AI Hub — Plan (current)

> **Last updated: May 2026.** This is the single source of truth for architectural decisions and weekly roadmap. The five user journeys live in [`docs/ROADMAP.md`](./docs/ROADMAP.md); the component design and request flow live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## What is this

Internal "AI front door" for Georgia-Pacific. Non-technical employees log in once and can do anything they'd want with AI — chat, run workflows against their work data, schedule recurring jobs — without thinking about which tool, which integration, which API. Rob is solo at ~10–15 focused hrs/week. Architecture must let new integrations (Workfront, Databricks, M365, GitHub, Salesforce, internal APIs) snap in without re-architecting, but must not pre-pay for that flexibility.

## Architecture in one picture

```
                ┌─────────────────────────────────┐
                │ apps/web (Next.js, App Runner)  │
                │   - GitHub OAuth (NextAuth v4)  │
                │   - chat UI / admin UI          │
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
        │  - bounded turn context │   │  - stateless turns  │
        │  - MCP servers          │   │  - fallback only    │
        │  - .cursor/hooks.json   │   │  (RUNTIME=bedrock)  │
        └────┬────────────────────┘   └─────────────────────┘
             │
   ┌─────────┼─────────┬──────────┬──────────┐
   │         │         │          │          │
┌──▼──┐  ┌──▼──┐  ┌───▼───┐  ┌──▼───┐  ┌────▼────┐
│ GH  │  │Graph│  │Workfr.│  │D-brks│  │ future  │
│ MCP │  │ MCP │  │  MCP  │  │ MCP  │  │  ...    │
│ ✅  │  │ stub│  │ stub  │  │ stub │  │         │
└─────┘  └─────┘  └───────┘  └──────┘  └─────────┘
```

- **Cursor SDK owns the runtime.** Durable agent state, streaming, tool-use protocol, model selection. We don't reimplement any of it.
- **Our app owns the enterprise shell.** Auth, persistence (chat history, audit log), the policy layer (`.cursor/hooks.json`), and the MCP servers exposing internal systems.
- **MCP is the integration pattern.** Every external system gets an MCP server. Standard transport, standard tool shape, standard auth seam. No bespoke tool wrappers per integration.
- **Bedrock stays.** Fallback runtime behind `RUNTIME=bedrock`. Both implement the same `AgentRuntime` interface; the chat route never knows which ran.

## Core principles

1. **Single runtime seam.** `AgentRuntime` is the only contract `apps/web` knows. `RUNTIME=cursor` and `RUNTIME=bedrock` both produce one. No code path branches on runtime above the seam.
2. **MCP is the integration pattern.** Every external system gets an MCP server. No bespoke tool wrappers.
3. **Recipes are the user-facing primitive.** A recipe is a Cursor agent definition — `{system_prompt, mcp_servers, model, params}`. Business users clone, edit, schedule.
4. **Permissions first-class.** `user_tool_attestations` from day one. The hook layer enforces them.
5. **Multi-model by design.** Haiku for fast/cheap inner loops; Sonnet as default; Opus for hard reasoning. Selectable per chat thread and per recipe.
6. **Defer abstractions until a second use case forces them.**

## Decisions locked

| Decision | What shipped |
|---|---|
| **Repo** | GitHub-hosted, monorepo, pnpm workspaces |
| **Identity (POC)** | GitHub OAuth via NextAuth v4. `users.ping_subject` stores the GitHub numeric user ID. Admins set by `role` column in DB. |
| **Identity (enterprise)** | PingOne / PingFederate OIDC. The NextAuth provider swaps; the `users` table and `getSessionUser()` helper do not change. `ping_subject` will hold the PingOne subject claim as originally intended. |
| **Agent runtime (default)** | **Cursor SDK** (`@cursor/sdk`, Anysphere). MCP-native. `RUNTIME=cursor` (now the default). Thread continuity currently comes from AI Hub's bounded context layer: rolling summary + recent messages. |
| **Agent runtime (fallback)** | **AWS Bedrock** (`converseStream`). Selected via `RUNTIME=bedrock`. |
| **Models** | Three Claude models — **Haiku 4.5**, **Sonnet 4.6** (default), **Opus 4.7**. Logical IDs map per runtime. |
| **Integration model** | **MCP servers** for every external system. HTTP for per-user delegated auth. GitHub MCP is live; others stubbed. |
| **Stack** | Next.js 15 (App Router) + TypeScript + Tailwind + Drizzle |
| **Hosting** | **AWS App Runner** behind a CodeBuild CI/CD pipeline. Image builds, DB migrations, and deploys run automatically on push to `main`. |
| **Database** | **RDS Postgres** via Drizzle. Migrations in `packages/db/drizzle/`. |
| **First working integration** | GitHub MCP — per-user, HTTP transport, tokens stored in `oauth_tokens`, accessed via `api.githubcopilot.com/mcp/` |

## Working model

- **Rob:** PM. Sets strategy, defines value, signs off Friday demos.
- **Claude (Cowork/Code):** Dev + PO agent. Breaks strategy into GitHub Issues, implements, opens PRs.
- **Cadence:** Ship something demoable to a skeptical exec every Friday in 5 minutes.

## Current state (May 2026)

### What's live in production

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
| Cursor SDK runtime (default) | ✅ |
| Bedrock runtime (fallback via `RUNTIME=bedrock`) | ✅ |
| GitHub MCP per-user (OAuth flow + token vault + live calls) | ✅ |
| AWS App Runner + CodeBuild CI/CD | ✅ |
| Rolling thread summaries + bounded turn context | ✅ |
| Safe closed-stream handling for long turns | ✅ |

### What's in the DB schema

| Table | Status |
|---|---|
| `users` | ✅ |
| `chat_threads` (with `cursor_agent_id`, `summary`, `summary_updated_at`) | ✅ |
| `chat_messages` | ✅ |
| `oauth_tokens` (AES-256-GCM encrypted, per-user) | ✅ |
| `invitations` | ✅ |
| `recipe_runs` | ✅ |
| `recipes` | ❌ not yet |
| `mcp_servers` | ❌ not yet |
| `tools_catalog` | ❌ not yet |
| `user_tool_attestations` | ❌ not yet |
| `audit_log` | ❌ not yet |

### Columns not yet added

- `chat_messages.runtime` (which runtime produced this message)

## Roadmap (weekly ships)

### ✅ Weeks 1–3 — Foundation

**Shipped:** Login → chat → streaming → threads persist → Cursor SDK runtime → GitHub OAuth + MCP → admin panel → invitations.

All code is on `main`. PRs #1–#22 merged. Only `origin/main` on remote.

### Week 4 — Graph (Mail / Calendar) MCP server

**Ship:** "What's on my calendar tomorrow, and which mails reference it?" — one agent turn calling two MCP servers.

- Promote `packages/mcp-servers/src/graph.ts` from stub → real. Microsoft Graph API (Mail + Calendar). Share the Entra app registration and the token store pattern already proven with GitHub MCP.
- Recipe: hardcoded "Morning Briefing" — system prompt + `mcp_servers: [graph-mail, graph-cal]` + Sonnet.
- Use the new `recipe_runs` table for the hardcoded "Morning Briefing" execution log.
- SES integration for outbound mail (briefing delivery).

**Note:** This requires Entra / M365 app registration approval from GP IT. If IT is delayed, swap in another Tier 1 integration (Salesforce OAuth, or Workfront) and come back to Graph.

### Week 5 — Schedule it

**Ship:** Monday 8am, briefing arrives without any user action.

- DB table for schedules + cron worker that calls `agent.send()` on cadence.
- Per-user schedule picker for the Morning Briefing recipe.
- Scheduled runs share the `AgentRuntime` seam — no second code path.

### Week 6 — Recipes catalog

**Ship:** A colleague creates their own recipe without Rob's help.

- `recipes` table + CRUD UI at `/recipes`.
- Each recipe row materializes into a Cursor agent definition at runtime.
- Morning Briefing becomes a row. Users clone and edit.
- 2–3 starter recipes (Morning Briefing, Weekly Status stub, etc.).
- Port `ai-intake` as Recipe 001 — proving the catalog can absorb an existing production use case.

### Week 7 — Tools catalog + attestations

**Ship:** Users see what's available, toggle what they have access to; recipes and chat respect toggles.

- `tools_catalog` table (admin-curated). Each tool maps to one MCP server + tool name.
- `user_tool_attestations` table.
- Tools page UI: tiles, attestation toggles, category grouping.
- `.cursor/hooks.json` extended: `preToolUse` checks attestation before allowing the call.

### Week 8 — Second non-Microsoft integration + admin / audit hardening

**Ship:** Cross-system recipe works ("search Workfront tasks and email me a summary").

- Promote `packages/mcp-servers/src/workfront.ts` or `databricks.ts` from stub → real. Picks whichever GP IT / GP data team clears first.
- Full `audit_log` writes (every MCP tool call, recipe run, admin change) via `postToolUse` hook.
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
| `chat_messages` | `id`, `thread_id`, `role`, `content`, `model_id`, `tokens_in`, `tokens_out`, `tool_calls` (jsonb), `tool_results` (jsonb), `created_at` |
| `oauth_tokens` | `id`, `user_id`, `provider`, `access_token`, `refresh_token`, `expires_at`, `scope`, `created_at`, `updated_at` |
| `invitations` | `id`, `email`, `token`, `invited_by`, `redeemed_at`, `created_at` |
| `recipe_runs` | `id`, `user_id`, `recipe_id` (nullable), `recipe_slug`, `thread_id`, `trigger_type`, `status`, `runtime`, `model_id`, `inputs`, `outputs`, `error`, `started_at`, `completed_at`, `created_at`, `updated_at` |

### Tables to add

| Table | When | Purpose |
|---|---|---|
| `mcp_servers` | Week 4 | Admin-curated MCP server registry |
| `recipes` | Week 6 | Saved agent definitions |
| `tools_catalog` | Week 7 | Admin-curated tool list (maps to MCP server + tool name) |
| `user_tool_attestations` | Week 7 | Per-user tool access grants |
| `audit_log` | Week 8 | Compliance trail — one row per MCP tool call |

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
- `preToolUse` hook checks `user_tool_attestations` (Week 7).

## Repo structure

```
apps/
  web/                     Next.js on App Runner; UI + auth + API routes
packages/
  db/                      Drizzle schema + client + migrations (0001–0008)
  agent/                   Tool/model registries + Bedrock loop
  cursor-runtime/          AgentRuntime seam
    src/
      types.ts             AgentRuntime interface, TurnInput, RuntimeName
      bedrock-runtime.ts   Wraps the existing runAgentLoop
      cursor-runtime.ts    @cursor/sdk adapter (fresh-agent-per-turn workaround for SDK MCP-state bug)
      db-thread-agent-store.ts  threadId → agentId visibility/persistence
      factory.ts           getRuntime() — defaults to 'cursor'
  mcp-servers/
    src/
      github.ts            ✅ GitHub MCP (per-user HTTP transport)
      graph.ts             stub — Week 4
      workfront.ts         stub — Week 8
      databricks.ts        stub — Week 8
.cursor/
  hooks.json               policy layer stubs (preToolUse, postToolUse) — to be wired Week 7–8
.github/workflows/         ci.yml (lint + typecheck + build)
docs/
  ARCHITECTURE.md          Component design, request flow, auth layers
  ROADMAP.md               Five journeys, integration tiers, flagship use cases
```

## Critical files

- `apps/web/app/api/chat/route.ts` — SSE relay into `getRuntime().runTurn()`. Runtime-agnostic.
- `apps/web/middleware.ts` — Unauthenticated → `/login`; non-admin on `/admin` → `/chat`.
- `apps/web/lib/auth/getSessionUser.ts` — Canonical user lookup: `WHERE id = session.user.id`.
- `packages/cursor-runtime/src/factory.ts` — `getRuntime()` defaults to `'cursor'`.
- `packages/cursor-runtime/src/cursor-runtime.ts` — `@cursor/sdk` adapter.
- `packages/db/src/schema.ts` — Drizzle schema.

## Top risks

1. **Cursor SDK surface stability** — v1 published May 2026; surface still moving. `BedrockRuntime` is the insurance policy. Mitigate by pinning a minor version and accepting the security-patch lag.
2. **Per-user delegated auth at MCP scale** — the pattern (HTTP transport + per-turn Bearer tokens) is proven with GitHub. Will it hold for Graph's token-refresh frequency when scheduling kicks in? Decide before week 5.
3. **M365 Entra app registration timing** — IT critical path for Graph MCP. Have a ready fallback (Salesforce or Workfront OAuth) if approval slips past week 4.
4. **Cost runaway** — cap `max_tokens`, ≤8 tool-use iterations per turn (hook enforcement), per-user daily token quotas, CloudWatch alarms at $50 / $200 / $500.
5. **Audit-log discipline** — `postToolUse` is the natural audit point. Integration test verifying every MCP call lands in `audit_log` before week 8 hardens.
6. **Burnout** — 10–15 focused hrs/week, blocks not scraps. If shipping slips two weeks in a row, reassess scope.

## Open questions

- **Single Graph MCP vs. one server per surface?** Default: separate mail + calendar servers. Revisit if duplicate token-refresh logic becomes a maintenance burden.
- **Recipes vs. Skills naming.** Same concept; pick the term that lands better with the first business-user reviewer. Decide before week 6 URL and table names are set.
- **Sunset Bedrock runtime?** Not now. Decide after Cursor has run a real workload for ≥1 month.
- **Cursor data residency.** Anysphere stores runtime-side agent state and tool transcripts. AI Hub keeps its own bounded context in Postgres, but GP data classification still needs a written answer from Anysphere before week 8 hardening.
