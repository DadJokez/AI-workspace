# Architecture — Comparative

> Companion to [`PLAN.md`](../PLAN.md) (weekly ship plan and decisions) and
> [`ROADMAP.md`](./ROADMAP.md) (user journeys and integration roadmap).
> This doc owns the end-state component picture: what each layer does,
> who owns it, and how a request flows through it. **Current-state claims were
> verified against `main` on 2026-07-23.** Re-baseline and advance this date
> whenever shipped/current claims change; do not use a transient commit SHA as
> the standing authority marker.

## Vision

GP employees should have one front door for AI — a place to log in once
with their corporate identity and do anything they'd reasonably want to
do with an LLM against their own work data: chat with mail, calendar
and Teams; ask questions of Workfront and Salesforce; explore Databricks
and Redshift; schedule recurring briefings; assemble small workflows
Skills without thinking about which API, which token, which model.
Comparative is that front door. The model and the runtime are
**implementation details** that the user never sees; the experience is
"I asked, it answered, it cited what it touched."

## Stack diagram

```
        ┌─────────────────────────────────────────────────────────┐
        │  User (browser / scheduled job / signed event)          │
        └────────────────────────────┬────────────────────────────┘
                                     │  NextAuth JWT (email magic link or GitHub)
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Enterprise Shell — apps/web (Next.js container)        │
        │   • ECS/Fargate web + worker services                   │
        │   • Auth: invite gate; PingOne OIDC remains planned     │
        │   • chat / Skills / Apps / tools / admin UI             │
        │   • persistence (RDS Postgres): threads, messages,      │
        │     runs, audit, tools, Skills, Apps, memory, sharing    │
        │   • AES-256-GCM delegated-token vault                   │
        │   • provider attestations + built-in web egress policy  │
        │   • /api/chat → AgentRuntime seam                       │
        └────────────────────────────┬────────────────────────────┘
                                     │  AgentRuntime.runTurn(...)
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  AWS runtime seam                                       │
        │   • BedrockRuntime: inline interactive/tool turns       │
        │   • AgentCoreRuntime: durable worker turns              │
        │   • model-decided routing; Sonnet 4.6 default           │
        │   • stable base tools + activated provider bundles      │
        └────────────────────────────┬────────────────────────────┘
                                     │
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Tool layer                                             │
        │   • MCP: GitHub, Google, Notion, Salesforce            │
        │   • built-in: public web search/fetch                   │
        └────────────────────────────┬────────────────────────────┘
                                     │  provider/public APIs
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Systems of record and public web                       │
        └─────────────────────────────────────────────────────────┘
```

## Component ownership

| Layer | Owns | Does not own |
|---|---|---|
| **User** | The intent. Picks the recipe or types the chat. | Tokens, model choice, transport. |
| **Enterprise Shell** (`apps/web`) | Identity, persistence, audit, policy, UI, Skill storage, token vault, thread-summary schema/helper, bounded context assembly, and built-in web egress policy. The seam (`AgentRuntime`) is the only thing it knows about the runtime. | Model API protocol or provider-specific agent-loop implementation. |
| **Bedrock runtime** | Same `AgentRuntime` contract via `converseStream` plus MCP client. Handles fast chat and interactive tool turns. | Durable worker ownership. |
| **AgentCore runtime** | Same `AgentRuntime` contract via Bedrock AgentCore Runtime. Handles durable chat, skill runs, schedules, and future app-build jobs. | Product state, user memory, schedule definitions, quota policy. |
| **MCP servers** | The auth handshake to a connected system and a small surface of provider tools. HTTP transport carries delegated per-user auth; stdio is supported for future M2M cases. | The agent loop, the model, the Skill definition, cross-system orchestration. |
| **First-party built-ins** | Narrow capabilities whose policy belongs in the runtime itself: currently public web search/fetch with SSRF and deny-wins egress controls. They use the same redaction, run-event, persistence, and audit path as MCP tools. | Connected-system auth or a way around MCP attestations. |
| **Internal systems** | The actual data and side effects. | Anything about how Comparative talks to them. |

## Product boundary: thin enterprise wrapper

Comparative is not trying to rebuild Bedrock, M365, Salesforce, Workfront,
Databricks, specialized IDEs, or the foundation-model layer. Its job is to make
those capabilities safe and usable for normal employees by adding the thin
enterprise shell they do not get from the raw platforms.

Comparative should own:
- the single front door and future enterprise SSO;
- tool connection UX, provider attestations, authorization checks, and token
  storage;
- recipes, schedules, run history, sharing, and discoverability;
- audit, redaction, retention, logging standards, quotas, and cost controls;
- the durable product data in Postgres: users, threads, messages, runs,
  tools, attestations, integration registry, and admin activity;
- the runtime seam that lets fast Bedrock turns and durable AgentCore turns
  share one product contract.

Comparative should avoid owning:
- foundation model hosting or low-level model APIs;
- a generic orchestration framework before Bedrock/AgentCore patterns prove
  insufficient;
- a full coding IDE or app deployment platform before J1-J3 are proven;
- custom one-off system integrations when an MCP server can expose the same
  capability in an inspectable, reusable way. Built-ins are reserved for
  bounded app-owned policy surfaces, not provider integration shortcuts.

The product rule for future work is: remove enterprise friction, do not
rebuild a platform unless Comparative needs that layer for control, audit,
governance, user experience, or portability.

## AWS runtime capability matrix

This matrix captures the current J1-J3 runtime boundary after the June 2026
AWS-only simplification.

| Journey | Runtime supports | Comparative must own | Current stance |
|---|---|---|---|
| **J1 Chat** | Bedrock streaming, model selection, direct text turns, cancellation at the product layer. | Auth, thread ownership, Postgres messages, bounded context, user settings, model labels, UI state, and runtime selection. | Supported. Comparative supplies bounded prior context and keeps product memory in Postgres. |
| **J2 Chat with Tools** | Bedrock tool loop with activated MCP provider bundles plus stable built-ins, streamed activity events, and model dispatch. | Per-user OAuth token vault, provider/category/tool mount gating, built-in egress policy, audit rows, tool/result persistence, user-facing connection flows, and redaction. | Supported with constraints. GitHub, Google, Notion, and Salesforce read-only v1 are shipped; public web search/fetch is built in. |
| **J3 Scheduled Agents** | AgentCore worker execution through the same runtime seam. | Schedule definitions, worker/cron trigger, `runs`, idempotency, retries, timeouts, quotas, delivery destinations, reconnect UI, and failure handling. | Time-based schedules and signed GitHub PR-review/failed-CI events are shipped; other event sources remain backlog. |

Do not assume the runtime owns enterprise scheduling, quota enforcement, data
retention, redaction, or long-term product memory. Bedrock/AgentCore is the AWS
runtime substrate; Comparative is the enterprise control plane.

## Auth model

### Layer 1 — Identity into the shell

**Current pilot:** NextAuth v4 with JWT sessions and an invite gate. Email magic
links are the universal tester path; GitHub OAuth is an optional secondary
provider. `AUTH_PROVIDERS` controls which are exposed.

**Enterprise target:** PingOne / PingFederate OIDC through the same auth seam.
The `users` table, `getSessionUser()`, and canonical user UUID remain stable;
the existing `ping_subject` column can hold the OIDC subject. The provider
itself is not shipped yet, so do not describe this as a configuration-only
cutover until the implementation and migration behavior are reviewed.

In both cases:
- `session.user.id` is the canonical `users.id` UUID (set in JWT callback via `token.userId = dbUser.id`).
- `users.ping_subject` stores the external subject used by the active identity path.
- Admin status is `users.role = 'admin'` — set directly in the DB.
- `getSessionUser()` in `lib/auth/getSessionUser.ts` is the canonical user lookup: `WHERE id = session.user.id`. All API routes use this.

### Layer 2 — Shell → MCP servers (per-user delegated)

This layer is **independent of the identity provider** in Layer 1. It uses the
same `oauth_tokens` table whether the user signs in by email, GitHub, or a future
enterprise IdP.

- For **delegated** systems (GitHub, Google, Notion, and Salesforce today), the
  shell holds each user's OAuth tokens in `oauth_tokens` (AES-256-GCM encrypted
  with `OAUTH_ENCRYPTION_KEY`). Provider credentials are refreshed/decrypted at
  turn or tool-call time and carried across an HTTP MCP boundary as a per-request
  Bearer or signed relay context.
- For future **service-principal / M2M** systems, the runtime supports stdio
  transport with credentials in `mcpServers[].env`; no shipped provider currently
  relies on that path.
- The tool gate checks `user_tool_attestations` and the tool catalog before
  MCP providers/tools are mounted for a turn.
- The shared turn executor writes one `audit_log` row per tool execution after
  each assistant message is persisted, for both MCP and built-in tools.

**Current delegated/identity integrations:**
1. SES-backed email magic links — primary invite-gated sign-in path.
2. `GITHUB_AUTH_CLIENT_ID` / `GITHUB_AUTH_CLIENT_SECRET` — optional sign-in identity app (NextAuth callback at `/api/auth/callback/github`).
3. `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — per-user GitHub MCP token app (callback at `/api/oauth/github/callback`). Scope: `repo read:user`. Stays as-is in enterprise — this is an MCP integration token, not the identity layer.
4. Google, Notion, and Salesforce each use their own per-user OAuth callback,
   encrypted token row, and first-party MCP endpoint. Salesforce v1 is read-only
   by construction.

## Recipes / skills catalog

A **recipe** (now "skill" in the product) is a row that materializes at runtime into an agent definition:

```ts
{
  system_prompt:    string,
  model_id:         'haiku-4-5' | 'sonnet-4-6' | 'opus-4-7',
  mcp_server_slugs: string[],    // e.g. ['github', 'graph-mail']
  allowed_tools:    string[],    // pinned subset of the servers' tools
  params_schema:    JSONSchema,  // user-supplied params at run time
  schedule_cron:    string | null,
}
```

Two things make this a catalog and not just "saved prompts":
1. **Provider requirements are first-class.** A Skill declares which MCP providers
   it needs and may pin an allowed subset of tools. Execution resolves those
   declarations against the user's current connections and grants.
2. **Attestations gate provider mounting.** Provider approvals can expose the
   provider's enabled catalog; category/tool grants expose only their enabled
   catalog matches. Built-in web tools are a separate app-owned policy tier and
   are never smuggled into `mcp_server_slugs`.

See [`ROADMAP.md`](./ROADMAP.md) for the use-case-driven view and the skills catalog flywheel.

## End-to-end request trace

Concrete example: user asks **"What PRs do I have open?"** in chat.

1. **Browser → ECS web container.** SSE POST to `/api/chat` with the thread id
   and the user's message. Cookie carries the NextAuth JWT.
2. **Shell** calls `getSessionUser(req)` → user row. Loads the `chat_threads` row, including the rolling `summary`, recent `chat_messages`, and the legacy `cursor_agent_id` column retained for migration compatibility only.
3. **Shell** resolves the user's capability graph, current grants, and connected
   provider catalog; model-decided routing selects the inline Bedrock lane.
4. **Shell** builds bounded context: stable policy prefix, pinned identity/skill
   blocks, rolling summary, recent messages, approved Vault memory, capability
   receipts, and the user's current message. The stable prefix pins the
   instruction layers in documented precedence — governance > org standing
   instructions > active skill > personal (custom instructions + approved
   Vault) > thread — and states the rule in the prompt: nearer-to-the-work
   wins for guidance (a skill's format beats a Vault preference for the
   skill's own output); protected keys (authorization, governance,
   model/provider identity, honesty/audit, date grounding) never yield to a
   lower layer. One source, `packages/agent/src/instruction-layers.ts`,
   renders the note for the shell and the evals; the
   `context_pack_assembled` receipt names which layers loaded
   ("Instructions · Skill: Weekly Status · 2 Vault memories · Org: not
   configured"). When a skill is pinned and custom instructions or approved
   Vault memory render, the preamble states the skill-over-personal
   conflict immediately above those personal blocks
   (`renderSkillOverPersonalNote`, #911): the rule in the note alone did
   not hold live, and neither did restating it inside the skill block or in
   the volatile suffix — only the line adjacent to the personal text did.
   The org layer is the approved rows of the dedicated `org_instructions`
   table (admin-written through `/api/org-instructions`, read by every
   user). It is deliberately not a Vault row: `user_memory_items.user_id`
   cascades on user deletion, while `org_instructions.authored_by` is SET
   NULL, so offboarding the authoring admin never deletes the layer. An org
   line that tries to change a protected key stays in the document but is
   void — the prompt carries a governance notice, the receipt a conflict
   count, and `audit_log` a denied row attributed to the authoring admin.
5. **BedrockRuntime** begins the streaming turn with stable base tools and the
   user's granted provider discovery catalog.
6. **Model** searches/activates GitHub when needed; the runtime mounts GitHub MCP
   over HTTP with the user's per-request Bearer credential.
7. **Model** calls the appropriate namespaced GitHub pull-request tool.
8. **MCP call** goes to `api.githubcopilot.com/mcp/` with the user's Bearer token. Returns the PR list.
9. **Model** assembles the answer. SSE events stream back through the shell to the browser.
10. **Shell** persists the assistant message to `chat_messages` with
    `model_id='sonnet-4-6'`, `runtime='bedrock'`, token metadata, structured
    redacted tool calls/results, run events, and one `audit_log` row per tool
    execution. After a successful turn the shell folds any history that aged
    out of the recent window into `chat_threads.summary` (schema
    `thread-summary.v1`: facts, open items, decisions, referenced resources by
    id) through the safe summarizer boundary in
    `packages/agent/src/thread-summary.ts`, using the registry's `summaries`
    purpose (#771). The next turn renders that summary at the head of the
    messages region as nonce-framed layer-6 background data.

Durable work follows the same product steps but routes the runtime call through
the AgentCore worker lane instead of the inline Bedrock lane.

## Long-running runs and activity state

`runs` (formerly `recipe_runs`) is the durable execution ledger for Skills,
scheduled jobs, chat-originated runs, and workflow-style agent turns. See
[`RUNS_DECISION.md`](./RUNS_DECISION.md) for the decision to keep one
generalized run ledger rather than split chat and recipe execution into
separate lifecycle tables. It stores the user,
optional future `recipe_id`, early `recipe_slug`, trigger type (`chat`,
`manual`, `scheduled`, etc.), runtime/model metadata, inputs, outputs, error
text, and lifecycle timestamps.

Every chat turn creates a `runs` row with `recipe_slug = chat-turn`. Normal
interactive turns mark that row running and stream inline through Bedrock on
the open `/api/chat` request. Durable-intent turns, Skills, schedules, and
events create queued rows consumed by the leased ECS chat-worker service, which
invokes AgentCore in production. The in-process worker remains a local/test
option and is disabled in the production web task. When the runtime accepts a
turn, Comparative stores provider/runtime metadata in `outputs.providerRun`
for visibility and debugging. Terminal runs fold back into `chat_messages` and
are marked succeeded/failed/canceled in `runs`.
The chat UI exposes cancel for queued/running chat turns and retry for
failed/canceled turns. Admin run detail exposes the same chat-originated
controls plus a resume/reconcile action for queued/running runs that need to be
picked up by a worker again. These lifecycle actions update `runs`, write
append-only `run_events`, and record `audit_log` rows.

The chat surface now has the first user-facing activity timeline. During a
streaming turn, tool-call and tool-result events update a compact activity row
inside the assistant message. After refresh or reconnect, the same component is
rebuilt from `chat_messages.tool_calls/tool_results`, so completed tool work
remains visible even when the live SSE stream is gone. Network/browser stream
drops are labeled as connection loss rather than model failure.

`run_events` is the append-only reloadable progress stream keyed to `runs.id`.
Chat turns and the Developer Briefing workflow write
high-level lifecycle events plus redacted tool-call/tool-result events. Thread
history and admin run detail can replay those events after reconnect, so users
can see what a long-running agent was doing even when the browser stream is no
longer live.

Workflow runs use the same event shape. The Developer Briefing route stores
redacted `toolCalls` and `toolResults` in `runs.outputs` for terminal
output, writes `run_events` for reloadable progress, and writes `audit_log`
rows for compliance. The admin run detail page at `/admin/runs/[id]` reuses the
chat activity renderer and also shows the raw run-event timeline.

This is a DB-backed queue consumed by the production ECS chat-worker service.
SQS/EventBridge becomes a later scale option if direct DB polling is not enough.
Step Functions remains reserved for explicit retry/wait-state audit
requirements. The important boundary is now clear: AgentCore owns durable
runtime execution; Comparative owns identity, run state, leases, activity replay,
audit, retry/cancel policy, tool governance, and the enterprise user
experience.

## Audit ledger

`audit_log` is the central append-only compliance ledger. After a chat turn
persists its assistant message, the shared executor writes one audit row per MCP
or built-in tool call/result with the actor, action type, status, provider/tool
names, tool-call id, links to the chat thread/message, input, output or error
payload, metadata, and lifecycle timestamps. Tool input/output payloads are
redacted before persistence. Admin, Skill-run, and security events reuse the
same table.

Admins can inspect recent ledger rows at `/admin/audit`. The page exposes the
latest tool, workflow, attestation, and rate-limit events with user, status,
provider/tool, chat or recipe context, duration, and error detail for failed or
denied work. This is the human-facing view; raw runtime events are not exposed
there by default.

## Tools catalog

`tools_catalog` is the admin-curated, user-visible inventory of MCP tools. It
maps provider-native tool names such as GitHub tools to display names,
descriptions, categories, read/write/admin action levels, attestation
requirements, enabled/disabled state, and optional metadata. It keeps
`provider + tool_name` as the stable lookup key and can now link each row to
`mcp_servers` through `mcp_server_id`.

Admins can inspect the registry and catalog at `/admin/tools`. The page shows
registered MCP servers, transport/auth mode, active provider approvals,
cataloged tools, action level, enabled state, and whether each tool requires
attestation. Editing remains a later admin-governance step; the current view is
read-only so the capability surface is visible before broader integrations land.

## User vault

The chat shell includes a user-facing Vault section beside Tools. Completed
chat turns enqueue transcript windows in `memory_capture_queue`. A dedicated
ECS memory-capture worker reviews pending windows in batches and does not call
the model when no new work exists. The web process can run the same delayed
scheduler locally, but production disables that in-process path. The worker can
compare them against the existing Vault, and write proposed `user_memory_items`
with source thread/message provenance.

Vault renders approved memory as Markdown and shows suggested updates for
explicit user review. Users can approve, edit, dismiss, or archive suggestions.
Only `approved` memory is rendered into the compact Personal Context block that
the chat worker injects into future agent turns.

The next hardening layer is deeper governance: approved retention/deletion
policy, legal hold, and category-level visibility defaults.

## MCP server registry

`mcp_servers` is the admin-curated registry of integrations Comparative can mount.
Each row has a stable slug, display name, description, transport (`http`,
`sse`, or `stdio`), status (`active`, `disabled`, or `planned`), endpoint URL,
auth mode, timestamps, and free-form metadata. GitHub was the initial seed;
the runtime now wires GitHub, Google, Notion, and Salesforce through
`MCP_PROVIDER_CONFIG`. The registry and tool catalog remain the governance
inventory, while provider-specific OAuth and execution endpoints live in the
application runtime. Future providers should land in both layers before they
are described as available.

## Tool attestations

`user_tool_attestations` records each user's explicit approval for a provider,
category, or individual tool. Rows preserve who approved the scope, when it was
approved, the maximum action level covered (`read`, `write`, or `admin`), and
optional tool-catalog linkage. The tool gate queries active rows
(`revoked_at IS NULL`) by user and provider before registering MCP tools for
the turn. Denied providers are written to the audit log with `status='denied'`.
Provider-admin approvals remain broad so existing OAuth connections keep
working even when a provider adds uncataloged tools. Category and tool-scoped
approvals only expose enabled rows from `tools_catalog`, and disabled catalog
rows are never registered with the model.

## Prompt guardrails

Per-turn context assembly means Comparative owns the context pack that gets sent to
the runtime. `buildTurnContext(...)` applies three deterministic
guardrails: `CHAT_RECENT_MESSAGE_LIMIT` bounds raw history count,
`CHAT_CONTEXT_CHAR_LIMIT` bounds total prompt context size, and
`CHAT_CONTEXT_MESSAGE_CHAR_LIMIT` bounds any single prior message or summary.
The current user message is always preserved exactly. When older history or a
summary is dropped/truncated, `/api/chat` emits a structured
`turn-context-guardrail` log with the thread, user, limit values, and retained
or dropped character counts.

Two further context-lifecycle edits (#771) act only on the messages region,
behind the ADR 0010 cache checkpoints, so neither can invalidate the stable
system prefix:

- **Stale tool-result clearing** (`packages/agent/src/context-lifecycle.ts`,
  applied by `runAgentLoop` before every provider call): once the
  model-visible transcript exceeds ~160K characters, tool rounds older than
  the two most recent are replaced by a placeholder carrying the tool name,
  call id, outcome, and a one-line excerpt. Error text is kept verbatim. The
  loop's own transcript and every emitted `tool-result` event keep the raw
  payload; the provider-request snapshot records what was cleared.
- **Rolling summary** (`apps/web/lib/thread-summary.ts`): after a successful
  turn, messages that aged out of `CHAT_RECENT_MESSAGE_LIMIT` and are not yet
  covered are summarized into `chat_threads.summary` (`thread-summary.v1`),
  read and written under `(id, user_id)`. Tool results enter the summarizer
  transcript redacted and bounded; the prior summary rides along as fenced
  data. The next turn renders the summary as layer-6 background data and the
  context receipt says it is there.

## Hosting decision: ECS/Fargate production

Comparative should stay inside AWS for the enterprise path. That keeps the product
inside the platform family IT already understands, preserves the current
container build/deploy shape, and avoids introducing a separate hosting vendor
while the core question is still product value.

**Current production:** **ECS on Fargate** using commit-tagged ECR images and the
current RDS database. CodeBuild and runtime configuration target the CDK-managed
ECS service set; image rollback redeploys an earlier commit tag through CDK.

| Layer | Current production | Later hardening |
|---|---|---|
| Web runtime | ECS service on Fargate, `ai-workspace-web` | Load-test before raising desired count |
| Workers | Separate ECS services for chat runs and Vault memory capture | Queue-backed dispatch if DB polling becomes limiting |
| Ingress | Application Load Balancer, ACM cert, Route 53 record at `comparative.builtwithrobot.link` with `ai-workspace.builtwithrobot.link` retained as a legacy alias | WAF/rate rules |
| Database | Existing RDS Postgres for fast cutover | RDS Proxy/Aurora and private DB posture |
| Secrets | AWS Secrets Manager JSON secrets: `ai-workspace/production/app` plus per-service least-privilege secrets (below) | KMS rotation policy |
| Networking | Default VPC for current RDS compatibility | Dedicated VPC/private subnets |
| Observability | CloudWatch logs/metrics/alarms, ALB health check on `/api/health` | Optional tracing |
| Edge controls | Minimal | ALB + WAF/rate rules when public enterprise traffic begins |
| IaC | CDK TypeScript in `infra/cdk` | Broaden to DB/proxy/edge resources |

Secrets are split by blast radius. `ai-workspace/production/app` holds the
application credentials (`DATABASE_URL`, `NEXTAUTH_SECRET`, OAuth client
secrets, `OAUTH_ENCRYPTION_KEY`) and is mounted only into the web, worker,
migrator, and smoke tasks. The Comparative Browser egress proxy instead reads
`ai-workspace/production/browser-proxy-db`, whose single key `DATABASE_URL`
carries the `web_egress_policy_reader` Postgres role: created `NOLOGIN` by
migration `0050_web_egress_policy_reader`, enabled for login by an operator out
of band, and granted `SELECT` on exactly `provider, tool_name, metadata` of
`tools_catalog` (the admin denylist row) and nothing else. The proxy's
Basic-auth pair lives in `ai-workspace/production/browser-proxy`. A compromised
proxy therefore reads one policy row, not the database.

ECS/Fargate is the AWS-native deployment for worker isolation, networking, IAM
boundaries, observability, and enterprise-scale planning.

## Enterprise scale posture

The current ECS/Fargate + RDS Postgres deployment is appropriate for the pilot,
but it is not yet a 100k-user architecture. Before enterprise scale,
Comparative needs explicit decisions and tests for:

- team/provider/model quotas beyond the shipped shared per-user request limiter;
- an explicit max-output-token policy on `/api/chat` (request and attachment
  sizes are already bounded);
- DB connection pooling, likely RDS Proxy or equivalent pooling before large
  concurrency;
- active provider-dependency health checks beyond the shipped Postgres and
  runtime-configuration checks;
- approved retention/deletion/legal-hold values beyond the shipped redaction,
  trace pruning, and audit-retention command;
- remaining KMS rotation, database-encryption, and private-network decisions;
- load tests and a scale decision on RDS Proxy/Aurora Postgres.

The current readiness decision record lives in
[`ENTERPRISE_READINESS.md`](./ENTERPRISE_READINESS.md). It documents the audit
triage, health check shape, shared Postgres rate limits, retention/redaction
policy, Secrets Manager/KMS/IaC target, and 1k/10k/100k load-test model.

## Developer Briefing workflow

`POST /api/workflows/developer-briefing/run` is the first production-shaped
manual workflow route. It creates a `runs` row, mounts the user's
attested GitHub MCP server, builds a dated Developer Briefing prompt through
`lib/developer-briefing.ts`, and runs it through the same `AgentRuntime` seam as
chat. The prompt asks GitHub read tools to aggregate authored PRs,
review-requested PRs, stale PRs, and CI/check state into a fixed Markdown
briefing. The route stores structured output/failure state on the run, including
redacted `toolCalls`/`toolResults` for the shared activity UI, and writes
redacted tool execution audit rows linked by `run_id`.
Admins can inspect recent runs at `/admin/runs` and open `/admin/runs/[id]` to
review the stored briefing, activity timeline, redacted tool payloads, prompt,
and linked audit events. Failed or canceled Developer Briefing runs can be
retried from the run detail page; the retry creates a new `runs` row with
`triggerType = manual_retry` and records the source run id in `inputs`. This
proves the recipe execution path before the full recipes table exists.
Chat-originated runs use the shared run detail page too, but their lifecycle
actions are handled by the chat run-control path so cancel, retry, resume, and
provider reconciliation stay consistent with the live chat surface.

## Agent Wire

**Agent Wire** is planned tooling to ingest Comparative runtime activity,
GitHub activity, and future tool events into S3 + Athena so we can ask
questions about how employees actually use AI. It is both a write path
(runtime/run-event exporters are the producers) and a read path (an
`agent-wire` MCP server). The S3/Athena schema must be reviewed before any of
this gets wired up beyond the current stub.

Key schema decisions to make before building:
- **Event taxonomy:** one row per turn (with N tool calls in a JSON column) or N+1 rows?
- **PII and retention:** hash or truncate tool args at write time; define S3 lifecycle TTLs.
- **Identity model:** Comparative `user_id` vs. GitHub username — the join table makes Athena queries work.
- **Schema evolution:** JSONL (fast start, harder to evolve) vs. Avro/Parquet + registry.

Until those are settled, Agent Wire stays as a stub in `mcp-servers/`; the S3 write path is a separate workstream.

## Historical migration sketch: ai-intake as Recipe 001

> This section records an early catalog-design exercise. It is not a description
> of the current product or an active dated delivery plan.

`ai-intake` (the prior internal AI intake tool) migrates as **Recipe 001** — the first non-trivial recipe in the catalog, deliberately chosen as a forcing function for every catalog feature without needing a new MCP server.

| ai-intake concept | Recipe equivalent |
|---|---|
| Form fields | `recipes.params_schema` (JSON Schema) |
| Form UI | Auto-generated from `params_schema` on `/recipes/:id/run` |
| System prompt | `recipes.system_prompt` |
| Model choice | `recipes.model_id` |
| Submit button | `getRuntime().runTurn(...)` with no MCP servers |
| Result page | `runs` row + standard run-detail UI |

Migration plan:
1. **Week 6:** port the ai-intake prompt into a `recipes` row. No MCP servers.
2. Run side by side for one release; compare outputs.
3. 301 the existing ai-intake URL to the recipe's run page. Archive the old repo after one quarter.
4. **Week 7+:** enrich with Graph MCP for context pull-in.

## Open questions

1. **AgentCore run durability.** Confirm reconnect/retry/cancel semantics under ECS task restarts and model/provider errors.
2. **Bedrock model access.** Registry entries and seeded enablement do not prove
   current account access or production DB state. Keep server-side model
   validation and displayed run provenance aligned with Bedrock access and the
   purpose-scoped enablement table.
3. **Provider-token caching.** Provider credentials are currently
   refreshed/decrypted at turn or tool-call time according to the provider.
   Measure latency and rate-limit pressure before introducing any
   session-scoped credential cache; a cache would need provider-aware expiry,
   revocation, and tenant-isolation guarantees.
4. **Catalog cold start.** Seed starter recipes ourselves (faster) or pair-author with 3 design-partner users (better recipes + adoption channel)? Decide end of week 5.
5. **Single Graph MCP vs. one server per surface.** Default: separate mail + calendar servers. Revisit after week 4 proves the pattern.
