# AI Hub ("Comparative") — Technical Overview

> **Self-contained brief for feature research.** This document is written so an
> agent or engineer *without repo access* can reason about the product, its
> architecture, its data model, and where feature work fits. It is a snapshot as
> of July 2026. Internal repo name: `ai-workspace`. Product name in UI/docs: **AI
> Hub**; the review/governance docs also call it **Comparative**. First customer:
> **Georgia-Pacific (GP)**, an internal enterprise deployment.

---

## 1. What it is, in one paragraph

AI Hub is an **internal AI front door for a large enterprise**. An employee logs
in once with their corporate identity and can: chat with an LLM against their own
work data; connect real work systems (GitHub, Gmail, Google Calendar, Notion,
soon M365/Salesforce/Workfront/Databricks) and let the agent both **read and act**
through them; save agents as reusable **Skills**; **schedule** those Skills or fire
them on **events** (e.g. a GitHub PR opened); build and deploy small internal
**Apps** from a chat conversation; and **share** Skills and Apps with teammates.
Everything is governed, audited, and executed on **AWS** (Bedrock + Bedrock
AgentCore). The core product thesis is that AI Hub is a **thin enterprise wrapper**
— it owns identity, governance, persistence, audit, and UX; it does **not** try to
rebuild the foundation model layer, M365, Salesforce, an IDE, or a hosting
platform.

**Product boundary rule (load-bearing):** *remove enterprise friction, do not
rebuild a platform unless AI Hub needs that layer for control, audit, governance,
UX, or portability.* Any feature proposal should be checked against this.

---

## 2. The five user journeys (the product's north star)

Everything is organized around five canonical journeys, in build order. Status is
as of July 2026.

| # | Journey | Status | One-liner |
|---|---|---|---|
| **J1** | **Chat** | ✅ Shipped (mature) | Streamed multi-turn chat, per-user threads, file/image uploads, model picker, Vault memory, first-run tour, slash-command palette. |
| **J2** | **Chat with Tools** | 🔄 In progress | Same chat surface, but the agent reaches the user's real systems via MCP and can read + act. GitHub/Gmail/Calendar/Notion live; M365/Salesforce/Workfront/Databricks next. |
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
- **Identity (Layer 1):** NextAuth v4 (JWT strategy). **GitHub OAuth** in the POC;
  designed to swap to **PingOne/PingFederate OIDC** for enterprise with *no DB
  migration* — the `users.ping_subject` column already holds the OIDC subject
  claim, and the swap is a single NextAuth provider config change.
- **Model runtime:** **AWS Bedrock** (`converseStream`) for fast chat + interactive
  tool turns; **Amazon Bedrock AgentCore** for durable/worker lanes (Skill runs,
  scheduled runs, event-triggered runs) executed session-isolated in the org's own
  AWS account. Selected behind a runtime seam via `RUNTIME=bedrock|agentcore`.
- **Models:** Bedrock-hosted Claude. See §3a — the effective state is
  **single-lane Sonnet 4.6**, not a three-model mix.
- **Tool integrations:** **MCP servers, one per system of record.** Hard rule:
  *every* agent capability is an MCP tool — no in-process function handlers, no
  agent-side closures pretending to be tools. GitHub MCP is remote
  (`api.githubcopilot.com/mcp/`); others are first-party endpoints under
  `/api/mcp/*` or stdio stubs.
- **Hosting:** target is **ECS on Fargate** (separate web, chat-run worker, and
  memory-capture worker services) behind an ALB, ACM cert, Route 53. **AWS App
  Runner** retained only as temporary rollback during cutover. IaC is **CDK**
  (TypeScript) in `infra/cdk`. Secrets in **AWS Secrets Manager**
  (`ai-workspace/production/app`). Observability via CloudWatch;
  ALB health check on `/api/health`.
- **CI/CD:** GitHub Actions (lint + typecheck + test + build on every PR and main
  push). Merge to `main` → CodeBuild builds web/chat-worker/memory-worker/migration
  images, runs Drizzle migrations, pushes to ECR, forces new ECS deployments.

### 3a. Model selection & routing — *current reality*

**Every standard chat turn runs on Sonnet 4.6.** This is a recent change (issue
#364, `docs/MODEL_DECIDED_ROUTING_SPEC.md`, ADR `docs/adr/0006-model-decided-tool-
routing.md`) and the most important thing to get right for feature research: a lot
of older code and docs still describe a three-model, multi-lane world that no longer
reflects runtime. Two independent mechanisms produce "Sonnet-only"; they are worth
keeping separate because only the first is provable from the repo.

**Mechanism 1 — the routing pin (provable from code + infra).** There are two
routing modes, `ROUTING_MODE = regex | model-decided`
(`apps/web/lib/chat-routing.ts:377`).
- **Production sets `model-decided`.** It is hard-coded in the CDK ECS stack's
  `commonEnvironment` (`infra/cdk/lib/ai-workspace-ecs-stack.ts:170`) and therefore
  applied to all three task definitions (web, chat-worker, memory-worker); it appears
  three times in the synthesized template (`infra/cdk/cdk.out/AiWorkspaceEcsStack.
  template.json` lines 273 / 1095 / 1606). The **local default is `regex`**
  (`apps/web/.env.example:79`) — so what you see running locally is *not* what prod
  does unless you set the env.
- Under `model-decided`, model selection is pinned in
  `apps/web/lib/runtime-model-policy.ts:113–119`: the branch returns
  `sonnet-4-6` with `reason: "model_decided_sonnet"`, *before* the autopilot branch
  runs. So the old length heuristic (`selectAutopilotModel`,
  `if (words <= 8) return "haiku-4-5"`, lines 44–46) is **unreachable in
  production** even though `RUNTIME_V2_DIRECT_MODEL_ID=auto` is also set — the
  model-decided branch short-circuits it. The `regex` path (multi-lane, keyword tool
  intent) survives only as break-glass rollback and is slated for deletion after soak
  (spec P4).
- **User model pins still win over the Sonnet pin.** `forceRequestedModel` branches
  (`runtime-model-policy.ts:88–111`) are evaluated *before* the model-decided branch,
  gated by `allowed(id)`. So if the picker still lets a user pin a model and that
  model is enabled, that turn uses it. Model-decided sets the *default* lane, it does
  not hard-lock every turn.
- **Merged and in the deploy path.** `origin/main` HEAD is `2f701fb "feat: roll out
  Sonnet 4.6 model-decided routing (#370)"`; local `main` matches origin with zero
  divergence, and both the infra env line and the `model_decided_sonnet` pin are on
  `main`. Since prod deploys from `main` (CodeBuild on push), this is live, not a
  pending branch. The `ROUTING_MODE` env flag is retained one more release as
  break-glass rollback, then removed (spec P4).

**Mechanism 2 — enablement (the DB switch; NOT verifiable from the repo).** Which
models may serve which purpose lives in the `model_enablement` table
(`(model_id, purpose)`), resolved by `apps/web/lib/model-registry.ts`. `allowed(id)`
in the policy is exactly this enablement set; a disabled model can never be selected,
and if Sonnet itself were disabled the pin falls back via `fallbackModelId()`.
**Caveat I want to be honest about:** the committed seed (migration
`0031_model_enablement.sql`) enabled *all three* tiers for every purpose, and I found
**no migration or code in the repo that disables Haiku.** So "Haiku is turned off" —
if it's set as an enablement flip rather than just an effect of the routing pin — is
a **production DB state I cannot confirm from the codebase.** The resolver fails open
only on DB *errors*; a reachable table is authoritative.

**What this means for the two claims you made:**
- *"Everything runs on Sonnet 4.6"* — **confirmed** for standard chat by Mechanism 1
  (infra env + the `model_decided_sonnet` pin). Also true for `memory-capture`, whose
  default is `sonnet-4-6` (`apps/web/.env.example:120`; resolved as a preference, not
  a bypass, `apps/web/lib/memory-capture.ts:388`).
- *"We turned off Haiku"* — **not evidenced in the repo.** The observable behavior
  (no user-facing turn lands on Haiku) is fully explained by the routing pin without
  needing an enablement change. If you also flipped Haiku off in `model_enablement`
  via the admin path, that's real but lives only in the prod DB. **To confirm:** query
  `SELECT model_id, purpose, enabled FROM model_enablement`, or check run telemetry
  for `reason = "model_decided_sonnet"`.

**Other model facts (from code):**
- The **metadata registry** (`packages/agent/src/models.ts`) still *defines* three
  tiers — `haiku-4-5`, `sonnet-4-6`, `opus-4-7` — with
  `DEFAULT_MODEL_ID = "sonnet-4-6"`. Defining ≠ enabling.
- **Sonnet 5** was registered then **reverted** (`312391c "Revert: register Claude
  Sonnet 5"`; the routing spec's non-goals list it explicitly). Bedrock account
  invocation access is pending AWS Support — do not assume Sonnet 5 is available.
- **Opus 4.7** is defined but account-gated (not reliably invocable).
- Haiku still legitimately appears in non-chat spots: `/model` aliases
  (`fast`/`haiku` → `haiku-4-5`), the now-unreachable autopilot heuristic,
  starter-skill seed prompts that *suggest* Haiku for simple Skills, and the fixed
  **evals judge model** (`packages/evals/src/judge.ts:39`, independent of what serves
  users).

**Net for feature research:** assume every user-facing turn is **Sonnet 4.6**. Treat
the multi-model picker, per-Skill model pinning, and Haiku/Opus lanes as *latent
capability* — the registry + enablement + pin-override plumbing all exist, but the
production routing pin makes Sonnet the effective single model today.

---

## 4. Architecture: layers and ownership

Request path, top to bottom:

```
User (browser / scheduled job / event)
   │  NextAuth JWT session (GitHub OAuth now → PingOne OIDC enterprise)
   ▼
Enterprise Shell — apps/web (Next.js container)
   • identity, persistence (RDS Postgres), audit, policy, UI
   • token vault: AES-256-GCM encrypted oauth_tokens
   • Skills/schedules/runs/shares/apps storage
   • bounded per-turn context assembly (buildTurnContext)
   • /api/chat → AgentRuntime seam
   ▼
AgentRuntime seam  (packages/agent-runtime)
   • BedrockRuntime (RUNTIME=bedrock): fast + interactive tool turns
   • AgentCoreRuntime (RUNTIME=agentcore): durable worker lanes
   • model selection (Sonnet 4.6 single-lane today — see §3a); MCP mounted per turn
   ▼
MCP servers (one per system of record)
   • HTTP transport + per-user Bearer token for delegated OAuth systems
   • stdio transport for machine-to-machine / service-principal systems
   ▼
Internal systems (GitHub, M365, Salesforce, Workfront, Databricks, …)
```

**Ownership split (memorize this — it's how the team decides what belongs where):**

- **The AWS runtime (Bedrock/AgentCore)** owns: streaming, the tool-use loop, model
  API protocol, MCP transport, durable worker execution, session isolation.
- **AI Hub (the shell)** owns everything enterprise: identity, thread/run
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

- **Layer 1 — identity into the shell.** GitHub OAuth (POC) → PingOne OIDC
  (enterprise). `session.user.id` = canonical `users.id` UUID.
  `getSessionUser()` (`lib/auth/getSessionUser.ts`) is the *only* sanctioned user
  lookup; all API routes use it. Admin = `users.role = 'admin'`.
- **Layer 2 — shell → MCP servers (per-user delegated).** Independent of Layer 1.
  User OAuth tokens live in `oauth_tokens` (AES-256-GCM, `OAUTH_ENCRYPTION_KEY`).
  At turn start the shell mints a short-lived token and injects it as
  `Authorization: Bearer <token>` into the MCP server request (HTTP transport, so
  the header is per-request). M2M/service-principal systems use stdio with creds in
  the MCP process env. **Two distinct GitHub OAuth apps exist**: one for sign-in
  identity (`GITHUB_AUTH_*`), one for per-user GitHub MCP tokens (`GITHUB_*`,
  scope `repo read:user`). Don't conflate them.

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
4. **Audit ledger** (`audit_log`). Central append-only compliance ledger. First
   producer: one row per MCP tool execution after each assistant message (actor,
   action, status, provider/tool, tool-call id, thread/message links, redacted
   input/output, timestamps). Tool payloads are **redacted before persistence**.
   Admin view at `/admin/audit`.

**Prompt-injection posture:** untrusted/user-authored content injected into a model
prompt must be framed as *data, not instructions* — nonce-delimited where the
pattern exists (`lib/artifact-context.ts`). Signed GitHub webhooks carry
prompt-injection framing before their content reaches a model.

**Per-turn context guardrails:** `buildTurnContext(...)` applies three deterministic
limits — `CHAT_RECENT_MESSAGE_LIMIT` (history count), `CHAT_CONTEXT_CHAR_LIMIT`
(total prompt size), `CHAT_CONTEXT_MESSAGE_CHAR_LIMIT` (any single message/summary).
The current user message is always preserved exactly; drops/truncations emit a
structured `turn-context-guardrail` log.

---

## 6. Data model (Postgres via Drizzle)

Tables (`packages/db/src/schema.ts`, ~1400 lines, 27 tables). Grouped by concern:

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

**Apps (J4)**
- `workspace_artifacts` — chat-built HTML artifacts.
- `apps`, `app_versions`, `app_edit_sessions` — deployed app registry, version
  groups (v2/v3 pills, revert), per-app edit locking.
- `recommendations` — quiet recommendation cards.

**Sharing & misc**
- `shares` — generic share rows (Skills + Apps today); recipients use own creds.
- `feedback_reports` — in-product feedback (+ screenshots).
- `rate_limit_buckets` — process-local fixed-window rate limiting.

**Enums:** `message_role`, `user_role`, `run_status`, `memory_capture_status`,
`user_memory_status`, `audit_log_status`, `tool_catalog_action`,
`mcp_server_transport`, `mcp_server_status`.

---

## 7. Key API surface (`apps/web/app/api/*`)

All routes: auth via `getSessionUser` → validate → act → typed JSON. `/api/chat`
streams SSE; `/api/health` is the only guard-free route (ALB health check).

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
3. Shell loads user's GitHub token from `oauth_tokens`, mints short-lived token.
4. Shell calls `getRuntime().runTurn({..., mcp_server_slugs:['github']})`.
5. `buildTurnContext` assembles bounded context; BedrockRuntime starts streaming.
6. Runtime mounts GitHub MCP (HTTP, per-turn Bearer).
7. Model calls `github.list_pull_requests(state='open', author='@me')`.
8. MCP call → `api.githubcopilot.com/mcp/` with user's Bearer → PR list.
9. Model composes answer; SSE streams back through shell to browser.
10. Shell persists assistant message (model, runtime, tokens, tool calls/results)
    + one `audit_log` row per tool execution.

**Durable variant:** every chat turn also creates a queued `runs` row
(`recipe_slug = chat-turn`) and returns the run id immediately; the actual turn is
executed by a **background chat-run worker** (leases, not a held-open request), so
long turns survive browser disconnect. Terminal runs fold back into `chat_messages`.
Scheduled/event/Skill runs follow the same product steps but route through the
AgentCore worker lane.

---

## 8. What's shipped vs. what's next (feature-research map)

**Shipped and mature (J1):** streamed chat, per-user threads with sidebar
history/rename/delete, stop/regenerate/edit-and-resend with persisted branch
replacement, Bedrock model registry + picker, business file uploads with server
extraction, native image blocks for screenshots, Vault memory suggestions with
approval, quiet recommendation cards, first-run tour, slash-command palette, full
mobile responsiveness, admin (users + invitations), settings.

**Shipped (J2/J3/J4/J5 slices):**
- GitHub MCP end-to-end (read + act); Gmail + Google Calendar + Notion connections.
- Tool catalog constrains mounted tools; redacted tool activity in chat; audit rows.
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
  Salesforce (wk9–10), Workfront/Databricks (wk8), ServiceNow (Tier 2, wk12+),
  unified `code-platform` GitHub+ADO (wk13+), SAP ERP (Tier 3, RFC-first).
- **Event triggers beyond GitHub** (J3): email-match, calendar-imminent, form
  submit, ServiceNow ticket assigned. Optional email delivery (#291).
- **Full App platform (J4, #133):** real git/pipeline substrate, per-app AWS
  services, deploy controller, workspace-as-IdP SSO for independently hosted apps.
  (Today's slice serves apps in-shell, no separate services.)
- **Broader sharing (J5, #78):** thread sharing, org-wide visibility, catalog/feed.
- **Agent Wire:** planned analytics pipeline (runtime + GitHub + tool events → S3 +
  Athena) plus an `agent-wire` MCP for querying usage. **Blocked on a schema
  review** (event taxonomy, PII/retention, identity join, JSONL vs Parquet).
- **Rolling thread-summary generation** (schema/helper exist; generation pending).
- **Human-in-the-loop confirmation** before destructive `create_*`/write tool calls
  (first needed by the IT Request Agent use case).

### Flagship use cases (each = a Skill with known MCP deps)

Meeting Prep, Weekly Status, Data Exploration for non-analysts, Customer Account
Briefing, IT Request Agent, Developer Workflow, SAP Budget Query. Tier-1
integrations cover 5 of 7 outright; the rest need Tier 2/3. See §2 journeys for how
these graduate from J2 (invoked) to J3 (scheduled/triggered).

---

## 9. Enterprise readiness posture (what's known-incomplete)

Current stack is POC/pilot-ready, **not** yet 100k-user enterprise scale. Explicit
open decisions before broad rollout:

- Request/tool-call **quotas** per user/team/provider/model.
- Body-size + max-output-token limits on `/api/chat`.
- DB **connection pooling** (likely RDS Proxy) before large concurrency; evaluate
  Aurora Postgres.
- **Health checks** that include DB + runtime dependency checks, not just liveness.
- **Redaction + retention** rules for `audit_log`, chat messages, tool I/O.
- Secrets via Secrets Manager/KMS + IaC; KMS rotation.
- Migration App Runner → ECS/Fargate (in progress); dedicated VPC/private subnets.
- Rate limiting is currently **process-local** (`rate_limit_buckets`) — needs a
  shared limiter before scale-out.

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

- **All tools are MCP servers.** A new capability is a new MCP tool, never an
  in-process shim. This is what keeps audit + attestation uniform.
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
  (tool/model registries, Bedrock loop, MCP client), `packages/mcp-servers` (local
  integration stubs), `infra/cdk` (ECS/ALB/Route53/Secrets), `specs/` (numbered
  feature specs: 001 runtime-v2, 002 skills-spine, 003 agentcore-substrate, 004
  eval-harness, 005 onboarding-wizard).

---

*Source docs this brief consolidates (in-repo): `README.md`, `docs/ARCHITECTURE.md`,
`docs/ROADMAP.md`, `PLAN.md`, `docs/ENTERPRISE_READINESS.md`, `AGENTS.md`,
`CLAUDE.md`, `packages/db/src/schema.ts`. If deeper detail is needed on a specific
area, those are the authoritative sources.*
