# Comparative — Technical Overview

> **Self-contained brief for feature research.** This document is written so an
> agent or engineer *without repo access* can reason about the product, its
> architecture, its data model, and where feature work fits. It is a snapshot as
> of July 2026. **Verified against `main` on 2026-07-23.** Internal repo name:
> `ai-workspace`; product name: **Comparative**. Time-sensitive "current" and
> "shipped" claims in this authority document must carry a verified-as-of date
> and be rechecked against code before downstream specs rely on them. First
> customer: **Georgia-Pacific (GP)**, an internal enterprise deployment.

### Snapshot corrections

- **2026-07-23:** re-baselined the authority docs to the live ECS deployment,
  invite-gated email/GitHub identity, shipped Salesforce read-only v1, inline
  versus durable execution lanes, and the bounded built-in web-tool tier.
- **2026-07-23:** replaced the inaccurate "every capability is MCP" rule with
  the actual boundary: connected systems use MCP; first-party web search/fetch
  are policy-controlled built-ins; every tool call shares the same redaction,
  run-event, persistence, and audit path.

---

## 1. What it is, in one paragraph

Comparative is an **internal AI front door for a large enterprise**. An employee
logs in once and can: chat with an LLM against their own work data; connect real
work systems (GitHub, Gmail, Google Calendar, Notion, and Salesforce read-only
v1) and let the agent use them within provider policy; save agents as reusable
**Skills**; **schedule** those Skills or fire them on **events** (e.g. a GitHub
PR opened); build and deploy small internal **Apps** from a chat conversation;
and **share** Skills and Apps with teammates. M365, Workfront, and Databricks
remain planned integrations. Everything is governed, audited, and executed on
**AWS** (Bedrock + Bedrock AgentCore). The core product thesis is that
Comparative is a **thin enterprise wrapper** — it owns identity, governance,
persistence, audit, and UX; it does **not** try to rebuild the foundation model
layer, enterprise systems of record, an IDE, or a hosting platform.

**Product boundary rule (load-bearing):** *remove enterprise friction, do not
rebuild a platform unless Comparative needs that layer for control, audit, governance,
UX, or portability.* Any feature proposal should be checked against this.

---

## 2. The five user journeys (the product's north star)

Everything is organized around five canonical journeys, in build order. Status
was verified on 2026-07-23.

| # | Journey | Status | One-liner |
|---|---|---|---|
| **J1** | **Chat** | ✅ Shipped (mature) | Streamed multi-turn chat, per-user threads, file/image uploads, model provenance, Vault memory, first-run tour, slash-command palette. |
| **J2** | **Chat with Tools** | 🔄 In progress | Same chat surface, with model-decided tool use. GitHub, Gmail/Calendar, Notion, and Salesforce read-only v1 are live through MCP; bounded web search/fetch are built in. M365/Workfront/Databricks are next. |
| **J3** | **Proactive Agent** | ✅ Schedules + GitHub events shipped | The same tool-agent invoked on a **schedule** or by an **event** instead of a keystroke. Time cadences + signed GitHub PR-review/failed-CI webhooks run Skills into designated threads. |
| **J4** | **App Build & Deploy** | 🔄 Thin slice shipped | Describe a small internal app in chat; agent writes it, previews, iterates; one-click deploy into an `apps` registry served SSO-gated at `/apps/{slug}`. Full git/pipeline substrate not yet built (#133). |
| **J5** | **Share** | 🔄 Seed shipped | Skills and Apps shared to named teammates who run/open with **their own** credentials; owner revokes. Thread sharing + org-wide catalog not yet. |

**Vocabulary note:** "recipes" was renamed to **Skills** everywhere in the product;
some older code/columns still say `recipe_*` (e.g. the run ledger table was
`recipe_runs`, now `runs`; chat turns use `recipe_slug = chat-turn`). Treat
"recipe" and "Skill" as the same concept.

---

## 3. Stack

- **Frontend/app:** Next.js 15 (App Router) + TypeScript + Tailwind, single web
  app in `apps/web`. pnpm workspaces monorepo.
- **DB:** Drizzle ORM + **RDS Postgres**. Migrations checked in (35+ migrations as
  of this snapshot).
- **Identity (Layer 1):** NextAuth v4 with JWT sessions and an invite gate.
  **Email magic links** are the universal tester path; **GitHub OAuth** is an
  optional secondary provider. `AUTH_PROVIDERS` controls the deployment
  allowlist. **PingOne/PingFederate OIDC is planned, not shipped**; the
  `users.ping_subject` column can hold its subject when that cutover lands.
- **Model runtime:** **AWS Bedrock** (`converseStream`) for fast chat + interactive
  tool turns; **Amazon Bedrock AgentCore** for durable/worker lanes (Skill runs,
  scheduled runs, event-triggered runs) executed session-isolated in the org's own
  AWS account. Selected behind a runtime seam via `RUNTIME=bedrock|agentcore`.
- **Models:** Bedrock-hosted Claude. See §3a — the effective state is
  **single-lane Sonnet 4.6**, not a three-model mix.
- **Tool integrations:** connected systems use **MCP servers**, normally one
  provider boundary per system of record. GitHub MCP is remote
  (`api.githubcopilot.com/mcp/`); Google, Notion, and Salesforce use first-party
  endpoints under `/api/mcp/*`. Public web search/fetch are deliberate
  **first-party built-ins**, not MCP: they are limited by app-owned egress
  policy and still flow through the shared tool redaction, event, persistence,
  and audit pipeline. MCP attestations govern connected providers; the built-in
  web tier is governed by route and global egress policy.
- **Hosting:** production runs on **ECS on Fargate**: separate web, chat-run
  worker, and memory-capture worker services behind an ALB, ACM certificate,
  and Route 53. IaC is **CDK** (TypeScript) in `infra/cdk`. Secrets are in
  **AWS Secrets Manager**
  (`ai-workspace/production/app`). Observability via CloudWatch;
  ALB health check on `/api/health`.
- **CI/CD:** GitHub Actions (lint + typecheck + test + build on every PR and main
  push). Merge to `main` → CodeBuild builds web/chat-worker/memory-worker/migration
  images, runs Drizzle migrations, pushes to ECR, forces new ECS deployments.

### 3a. Model selection & routing — *current reality*

- Every newly routed chat turn uses the **model-decided** engine. The deleted
  regex engine survives only as a legacy value on already-persisted runs.
- Standard chat defaults to **Sonnet 4.6** through
  `runtime-model-policy.ts` (`reason = model_decided_sonnet`). Explicit,
  enabled model overrides are still supported by the server, while the v2 chat
  header does not expose the old picker.
- Model enablement is purpose-scoped in the `model_enablement` table. The repo
  proves selection logic and seed state, not any later production-only admin
  changes; verify the table or run receipts before asserting live enablement.
- The registry (`packages/agent/src/models.ts`) defines the Claude tiers plus
  the registered-but-disabled candidates from #797 (Nova Pro and the
  2026-09-06 gaggle; scorecards in `docs/models/`). Definition is not proof
  of Bedrock account access or production enablement — only Haiku 4.5,
  Sonnet 4.6 and Opus 4.7 have seeded enablement rows.
- Routing and model provenance are persisted on the run receipt. Do not pin an
  authority document to a transient `main` SHA; use the verified-as-of date and
  the deployment receipt for an exact production revision.

---

## 4. Architecture: layers and ownership

Request path, top to bottom:

```
User (browser / scheduled job / event)
   │  NextAuth JWT session (invite-gated email magic link or GitHub OAuth)
   ▼
Enterprise Shell — apps/web (Next.js container)
   • identity, persistence (RDS Postgres), audit, policy, UI
   • token vault: AES-256-GCM encrypted oauth_tokens
   • Skills/schedules/runs/shares/apps storage
   • bounded per-turn context assembly (buildTurnContext)
   • /api/chat → AgentRuntime seam
   ▼
AgentRuntime seam  (packages/agent-runtime)
   • BedrockRuntime: inline interactive chat and tool turns
   • AgentCoreRuntime: durable worker lanes
   • model selection (Sonnet 4.6 default — see §3a)
   ▼
Tool layer
   • MCP servers for connected systems (GitHub, Google, Notion, Salesforce)
   • HTTP transport + per-user Bearer token for delegated OAuth systems
   • bounded first-party web search/fetch with global egress policy
   ▼
External systems and public web
```

**Ownership split (memorize this — it's how the team decides what belongs where):**

- **The AWS runtime (Bedrock/AgentCore)** owns: streaming, the tool-use loop, model
  API protocol, MCP transport, durable worker execution, session isolation.
- **Comparative (the shell)** owns everything enterprise: identity, thread/run
  persistence, bounded context, token vault, provider/tool attestations, audit
  logging, quotas, redaction, retention, schedules, delivery destinations, run
  lifecycle (lease/cancel/retry/resume), activity replay, and the Skills catalog.

> Do **not** assume the runtime owns scheduling, quotas, retention, redaction, or
> long-term memory. Those are always the shell's job. This is the single most
> common architectural mistake to avoid in feature design.

### Runtime seam contract

`getRuntime().runTurn({ thread, message, model, mcp_server_slugs, ... })` is the one
thing the shell knows about the runtime. Both Bedrock and AgentCore implement the
same `AgentRuntime` contract (`packages/agent-runtime/src/{bedrock-runtime,
agentcore-runtime,factory,types}.ts`). Keeping the product model- and
provider-portable behind this seam is an explicit invariant.

### Two auth layers (keep them separate)

- **Layer 1 — identity into the shell.** Invite-gated email magic links are the
  universal tester path; GitHub OAuth is optional. PingOne/PingFederate OIDC
  remains the enterprise target. `session.user.id` = canonical `users.id` UUID.
  `getSessionUser()` (`lib/auth/getSessionUser.ts`) is the sanctioned user lookup;
  authenticated product routes use it. Admin = `users.role = 'admin'`.
- **Layer 2 — shell → MCP servers (per-user delegated).** Independent of Layer 1.
  User OAuth tokens live in `oauth_tokens` (AES-256-GCM, `OAUTH_ENCRYPTION_KEY`).
  The shell refreshes or decrypts provider credentials at turn/tool-call time and
  injects a per-request Bearer or relay credential into the MCP boundary. M2M/
  service-principal stdio transport is a supported runtime shape but is not the
  active path for the shipped delegated integrations. **Two distinct GitHub OAuth
  apps exist**: one for optional sign-in identity (`GITHUB_AUTH_*`), one for
  per-user GitHub MCP tokens (`GITHUB_*`, scope `repo read:user`). Do not conflate
  them.

---

## 5. Governance model (the enterprise spine)

This is what makes it "enterprise" rather than "a chat app." Four cooperating
mechanisms:

1. **Tool attestations** (`user_tool_attestations`). Each user explicitly approves a
   provider, category, or individual tool, at a max action level (`read`/`write`/
   `admin`). The tool gate queries active rows (`revoked_at IS NULL`) before MCP
   tools are registered for a turn. **Provider-admin approvals stay broad** (so
   existing OAuth connections keep working when a provider adds new tools);
   **category/tool approvals expose only enabled catalog matches**; disabled catalog
   rows are never registered with the model. Denied providers get an audit row with
   `status='denied'`.
2. **Tools catalog** (`tools_catalog`). Admin-curated inventory mapping
   provider-native tool names → display name, description, category, action level
   (read/write/admin), attestation requirement, enabled flag. Stable key is
   `provider + tool_name`; can link to `mcp_servers`. Visible read-only at
   `/admin/tools`.
3. **MCP server registry** (`mcp_servers`). Admin-curated integration registry:
   slug, transport (`http`/`sse`/`stdio`), status (`active`/`disabled`/`planned`),
   endpoint, auth mode. New providers can be added as registry data first, wired
   into runtime later.
4. **Audit ledger** (`audit_log`). Central append-only compliance ledger. The
   shared turn executor writes one row per tool execution, including MCP and
   first-party built-ins, after the assistant message is persisted (actor, action,
   status, provider/tool, tool-call id, thread/message links, redacted input/output,
   timestamps). Tool payloads are **redacted before persistence**. Admin view at
   `/admin/audit`.

MCP attestations govern connected provider tools. The built-in web tier is not an
MCP provider and does not pretend to use MCP attestations; it is mounted by the
chat route, constrained by the admin-global deny-wins egress policy, and audited
through the same shared execution pipeline.

**Prompt-injection posture:** untrusted/user-authored content injected into a model
prompt is framed as *data, not instructions*. Attachments, artifacts, provider
records, web results, and generic MCP tool results use source-specific or
nonce-delimited boundaries; forged marker families are stripped before model
delivery. Signed GitHub webhooks carry the same data-not-instructions treatment
before their content reaches a model.

**Per-turn context guardrails:** `buildTurnContext(...)` applies three deterministic
limits — `CHAT_RECENT_MESSAGE_LIMIT` (history count), `CHAT_CONTEXT_CHAR_LIMIT`
(total prompt size), `CHAT_CONTEXT_MESSAGE_CHAR_LIMIT` (any single message/summary).
The current user message is always preserved exactly; drops/truncations emit a
structured `turn-context-guardrail` log.

---

## 6. Data model (Postgres via Drizzle)

Tables (`packages/db/src/schema.ts`). Grouped by concern:

**Identity & settings**
- `users` — id (UUID, canonical), email, `ping_subject` (OIDC/OAuth subject),
  `role` (`user`/`admin`), custom instructions, default model, assistant name.
- `invitations` — admin pre-invites by email (+ email delivery state).
- `model_enablement` — which Bedrock models are enabled/default.

**Chat**
- `chat_threads` — per-user threads; rolling `summary` (schema/helper exist,
  generation still pending); legacy `cursor_agent_id` retained for migration only.
- `chat_messages` — role, content, `model_id`, `runtime`, token metadata, structured
  `tool_calls`/`tool_results` (redacted), used to rebuild activity UI after reconnect.

**Tools / integrations / governance**
- `oauth_tokens` — AES-256-GCM encrypted per-user delegated tokens.
- `mcp_servers`, `tools_catalog`, `user_tool_attestations`, `audit_log` (see §5).

**Skills & automation**
- `skills` — the saved-agent definition (system prompt, model, MCP server slugs,
  allowed tools, params schema, optional schedule). This is the "recipe" row.
- `schedules` — cron/cadence definitions; leased scheduler tick; timezone/DST-safe.
- `event_triggers` + `event_trigger_deliveries` — event sources (GitHub webhooks
  today) with durable delivery dedupe.
- `runs` — **the one generalized execution ledger** for chat turns, manual runs,
  scheduled runs, event runs, and workflow runs. Stores user, trigger type
  (`chat`/`manual`/`scheduled`/…), runtime/model metadata, inputs, outputs, error,
  worker lease fields, lifecycle timestamps. (Deliberately *not* split into
  separate chat vs. recipe tables — see `docs/RUNS_DECISION.md`.)
- `run_events` — append-only, reloadable per-run progress stream (lifecycle +
  redacted tool-call/result events) so activity replays after reconnect.
- `notifications` — user notifications (+ digest).

**Memory (Vault)**
- `memory_capture_queue` — transcript windows enqueued after successful chats.
- `user_memory_items` — proposed/approved memory with source thread/message
  provenance; only `approved` items feed the Personal Context block into future
  turns.
- `org_instructions` — admin-written organization standing instructions (#438,
  layer 3), loaded into every user's turn; `authored_by` is provenance only
  (SET NULL on user deletion), so the layer outlives its author.

**Apps (J4)**
- `workspace_artifacts` — chat-built HTML artifacts.
- `apps`, `app_versions`, `app_edit_sessions` — deployed app registry, version
  groups (v2/v3 pills, revert), per-app edit locking.
- `recommendations` — quiet recommendation cards.

**Sharing & misc**
- `shares` — generic share rows (Skills + Apps today); recipients use own creds.
- `feedback_reports` — in-product feedback (+ screenshots).
- `rate_limit_buckets` — shared Postgres fixed-window rate limiting across ECS
  tasks; the in-memory store exists only as a test/local seam.

**Enums:** `message_role`, `user_role`, `run_status`, `memory_capture_status`,
`user_memory_status`, `audit_log_status`, `tool_catalog_action`,
`mcp_server_transport`, `mcp_server_status`.

---

## 7. Key API surface (`apps/web/app/api/*`)

User-facing product routes authenticate through `getSessionUser`; admin routes
add `requireAdmin`, while OAuth callbacks, signed webhooks, MCP relays, health,
and deployed-app access use their purpose-built boundaries. `/api/chat` streams
SSE; `/api/health` is the ALB health endpoint.

- **Chat/threads:** `POST /api/chat` (stream), `threads`, `threads/[id]`,
  `threads/[id]/messages`, `threads/[id]/export`, `me`, `user`, `models`.
- **Runs (lifecycle):** `runs`, `runs/[id]`, `runs/[id]/{cancel,retry,resume}`.
- **Skills:** `skills`, `skills/[id]`, `skills/[id]/{run,clone,export}`,
  `skills/import`, `skills/seed`.
- **Automation:** `schedules`, `schedules/[id]`, `event-triggers`,
  `event-triggers/[id]`, `webhooks/github` (signed), `workflows/developer-briefing/run`.
- **Apps (J4):** `apps`, `apps/[id]`, `apps/[id]/deploy`, `apps/[id]/edit-sessions`,
  `apps/[id]/versions`, `.../versions/[versionId]`, `.../content`.
- **Workspace artifacts:** `workspace/artifacts`, `.../[id]`, `.../[id]/download`.
- **OAuth connect (per-user MCP tokens):** `oauth/{github,google,notion,salesforce}/
  {start,callback}`, `oauth/status`.
- **First-party MCP endpoints:** `mcp/{google,notion,salesforce}`.
- **Vault:** `vault/memory`, `vault/memory/[id]`.
- **Sharing / feedback / notifications / recommendations:** `shares`, `shares/[id]`,
  `feedback`, `notifications*`, `recommendations*`.
- **Admin:** `admin/users*`, `admin/invitations*`, `admin/feedback*`; admin UI
  pages at `/admin/{audit,tools,runs,runs/[id]}`.

### End-to-end trace ("What PRs do I have open?")

1. Browser SSE `POST /api/chat` with thread id + message; NextAuth JWT cookie.
2. Shell `getSessionUser` → user; loads thread (summary + recent messages).
3. Shell resolves the user's granted tool catalog and current GitHub credential.
4. Model-decided routing chooses the inline Bedrock lane for this interactive turn.
5. The context pack assembles bounded history, approved Vault context, capability
   receipts, and the stable tool-discovery bundle.
6. The model searches/activates GitHub when needed; the runtime mounts GitHub MCP
   over HTTP with the user's per-request Bearer credential.
7. Model calls the appropriate namespaced GitHub pull-request tool.
8. MCP call → `api.githubcopilot.com/mcp/` with the user's Bearer → PR list.
9. Model composes answer; SSE streams back through shell to browser.
10. Shell persists assistant message (model, runtime, tokens, tool calls/results)
    + one `audit_log` row per tool execution.

Every chat turn gets a `runs` ledger row. Normal interactive turns execute inline
through Bedrock and stream over the open request. Durable-intent turns, Skills,
schedules, and event triggers are queued for the leased **chat-run worker**, which
invokes AgentCore in production and survives browser disconnect. Terminal worker
runs fold back into `chat_messages`.

---

## 8. What's shipped vs. what's next (feature-research map)

**Shipped and mature (J1):** streamed chat, per-user threads with sidebar
history/rename/delete, stop/regenerate/edit-and-resend with persisted branch
replacement, Bedrock model registry + persisted model provenance, business file
uploads with server
extraction, native image blocks for screenshots, Vault memory suggestions with
approval, quiet recommendation cards, first-run tour, slash-command palette, full
mobile responsiveness, admin (users + invitations), settings.

**Shipped (J2/J3/J4/J5 slices):**
- GitHub MCP end-to-end (read + act); Gmail/Google Calendar and Notion read/write
  surfaces; Salesforce read-only v1; built-in public web search/fetch.
- Tool catalog constrains MCP providers; global egress policy constrains built-in
  web tools; all tool activity is redacted, evented, persisted, and audited.
- `runs` ledger + `run_events` reloadable activity + cancel/retry/resume.
- `schedules` with leased tick + timezone-safe cadences into designated threads.
- Signed GitHub webhooks (PR review, failed CI) → owner-scoped Skill runs with
  dedupe, rate limiting, injection framing, audit, notifications, pause/delete.
- Developer Briefing manual workflow (GitHub PR/CI aggregation).
- Chat-built HTML artifacts → one-click Apps at `/apps/{slug}` (restrictive CSP),
  version groups + plain-language revert, no-secrets scan, conversational iteration.
- Named Skill/App shares with recipient-credential execution + owner revoke.

**Next / not yet built (highest-leverage feature areas):**
- **More integrations (J2):** M365 Graph (Mail wk4, Calendar, Files+Teams wk8),
  Salesforce writes, Workfront/Databricks (wk8), ServiceNow (Tier 2, wk12+),
  unified `code-platform` GitHub+ADO (wk13+), SAP ERP (Tier 3, RFC-first).
- **Event triggers beyond GitHub** (J3): email-match, calendar-imminent, form
  submit, ServiceNow ticket assigned; external result delivery remains future work.
- **Full App platform (J4, #133):** real git/pipeline substrate, per-app AWS
  services, deploy controller, workspace-as-IdP SSO for independently hosted apps.
  (Today's slice serves apps in-shell, no separate services.)
- **Broader sharing (J5, #78):** thread sharing, org-wide visibility, catalog/feed.
- **Agent Wire:** planned analytics pipeline (runtime + GitHub + tool events → S3 +
  Athena) plus an `agent-wire` MCP for querying usage. **Blocked on a schema
  review** (event taxonomy, PII/retention, identity join, JSONL vs Parquet).
- **Rolling thread-summary generation** (schema/helper exist; generation pending).
- **Broader write governance:** Google Calendar already uses a prepare/confirm
  boundary; destructive write tools still need provider-specific approval policy.

### Flagship use cases (each = a Skill with known MCP deps)

Meeting Prep, Weekly Status, Data Exploration for non-analysts, Customer Account
Briefing, IT Request Agent, Developer Workflow, SAP Budget Query. Tier-1
integrations cover 5 of 7 outright; the rest need Tier 2/3. See §2 journeys for how
these graduate from J2 (invoked) to J3 (scheduled/triggered).

---

## 9. Enterprise readiness posture (what's known-incomplete)

Current stack is POC/pilot-ready, **not** yet 100k-user enterprise scale. Explicit
open decisions before broad rollout:

- Team/provider/model **quotas** beyond the shipped per-user/shared request limiter.
- Explicit max-output-token policy on `/api/chat`; request and attachment sizes are
  already bounded.
- DB **connection pooling** (likely RDS Proxy) before large concurrency; evaluate
  Aurora Postgres.
- Health checks that actively probe provider dependencies; `/api/health` already
  checks Postgres and runtime configuration.
- Approved **retention/deletion/legal-hold** values beyond the shipped redaction,
  trace pruning, and audit-retention command.
- KMS rotation and the remaining at-rest encryption decisions.
- Dedicated VPC/private subnets and load tests at intended concurrency.

---

## 10. Open questions worth knowing (they shape feature scope)

1. **AgentCore run durability** — reconnect/retry/cancel semantics under ECS task
   restarts and provider errors.
2. **Token lifetime** — per-turn short-lived token refresh vs. session-scoped cached
   token (Redis, ~50-min TTL). Cost compounds with scheduling.
3. **Integration granularity** — one `data-lake` MCP for Databricks+S3+Redshift vs.
   three; one `graph-*` server vs. split mail/cal/files; one `code-platform` for
   GitHub+ADO vs. two. Default leaning: split Graph, unify data-lake and
   code-platform — all revisit-after-spike.
4. **Agent Wire schema** — blocking Tier 2 closeout.
5. **Catalog cold-start** — hand-seed 5–10 starter Skills vs. pair-author with
   design partners.
6. **Subagents/parallel tool execution** — promising but explicitly *not* a J1–J3
   dependency; only after the simple tool/schedule path is proven.

---

## 11. Conventions & guardrails for anyone proposing changes

- **Connected systems use MCP by default.** Keep provider auth and system-of-record
  operations behind inspectable MCP boundaries. A bounded first-party built-in is
  acceptable only when the shell must own the policy directly (currently public
  web search/fetch); it must use the shared redaction, event, persistence, and
  audit path and document its non-attestation control.
- **Runtime portability** behind the `AgentRuntime` seam is an invariant — don't
  bind the shell to a specific model/provider.
- **Data scoping** — every data access scoped to the requesting user; never
  cross-user. No secrets/keys/tokens in code, logs, or client bundles.
- **Honesty/grounding is the product's spine** — the assistant must never deny a
  capability/data it actually has, fabricate a tool result, or misstate its model,
  identity, or the date.
- **Client/server boundary** — client components must not import server-only modules
  (DB, secrets, server SDKs); this breaks the build even when typecheck passes.
- **Human-owned changes** — new production dependency, DB migration, or
  auth/permissions/secret/env change require the owner's explicit sign-off; they are
  called out, not waved through.
- **Repo layout:** `apps/web` (Next.js app), `apps/agentcore-agent` (AgentCore agent
  loop container, `POST /invocations` SSE + `GET /ping`), `packages/db` (Drizzle
  schema/migrations), `packages/agent-runtime` (runtime seam), `packages/agent`
  (tool/model registries, Bedrock loop, MCP client), `packages/mcp-servers`
  (spike-only placeholder stubs, not an active runtime dependency), `infra/cdk`
  (ECS/ALB/Route53/Secrets), `specs/` (numbered
  feature specs: 001 runtime-v2, 002 skills-spine, 003 agentcore-substrate, 004
  eval-harness, 005 onboarding-wizard).

---

*Source docs this brief consolidates (in-repo): `README.md`, `docs/ARCHITECTURE.md`,
`docs/ROADMAP.md`, `PLAN.md`, `docs/ENTERPRISE_READINESS.md`, `AGENTS.md`,
`CLAUDE.md`, `packages/db/src/schema.ts`. If deeper detail is needed on a specific
area, those are the authoritative sources.*
