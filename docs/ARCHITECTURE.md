# Architecture — AI Hub

> Companion to [`PLAN.md`](../PLAN.md) (weekly ship plan and decisions) and
> [`ROADMAP.md`](./ROADMAP.md) (user journeys and integration roadmap).
> This doc owns the end-state component picture: what each layer does,
> who owns it, and how a request flows through it. Updated as decisions land.

## Vision

GP employees should have one front door for AI — a place to log in once
with their corporate identity and do anything they'd reasonably want to
do with an LLM against their own work data: chat with mail, calendar
and Teams; ask questions of Workfront and Salesforce; explore Databricks
and Redshift; schedule recurring briefings; assemble small workflows
("recipes") without thinking about which API, which token, which model.
The AI Hub is that front door. The model and the runtime are
**implementation details** that the user never sees; the experience is
"I asked, it answered, it cited what it touched."

## Stack diagram

```
        ┌─────────────────────────────────────────────────────────┐
        │  User (browser / scheduled job / email)                 │
        └────────────────────────────┬────────────────────────────┘
                                     │  GitHub OAuth session (NextAuth v4)
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Enterprise Shell — apps/web (Next.js container)        │
        │   • POC: App Runner → enterprise: ECS/Fargate           │
        │   • Auth: GitHub OAuth (POC) → PingOne OIDC (enterprise)│
        │   • chat UI / recipes UI / tools catalog UI             │
        │   • persistence (RDS Postgres): threads, messages,      │
        │     recipe runs, audit log, tools, future recipes/authz │
        │   • token vault (AES-256-GCM encrypted oauth_tokens)   │
        │   • policy layer (provider gate now; hooks/proxy later) │
        │   • /api/chat → AgentRuntime seam                       │
        └────────────────────────────┬────────────────────────────┘
                                     │  AgentRuntime.runTurn(...)
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  AWS runtime seam                                       │
        │   • BedrockRuntime (RUNTIME=bedrock): fast/tool turns   │
        │   • AgentCoreRuntime (RUNTIME=agentcore): workers       │
        │   • model selection (Haiku / Sonnet / Opus)             │
        │   • MCP servers mounted per turn                        │
        └────────────────────────────┬────────────────────────────┘
                                     │  MCP (HTTP+Bearer per-user | stdio M2M)
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  MCP servers (one per system of record)                 │
        │   github ✅ · graph (stub) · workfront (stub) · ...    │
        └────────────────────────────┬────────────────────────────┘
                                     │  vendor APIs
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Internal systems                                       │
        │   GitHub / M365 / Salesforce / Workfront / Databricks   │
        └─────────────────────────────────────────────────────────┘
```

## Component ownership

| Layer | Owns | Does not own |
|---|---|---|
| **User** | The intent. Picks the recipe or types the chat. | Tokens, model choice, transport. |
| **Enterprise Shell** (`apps/web`) | Identity, persistence, audit, policy, UI, recipe storage, token vault, thread-summary schema/helper, and bounded context assembly. The seam (`AgentRuntime`) is the only thing it knows about the runtime. | Tool-use loop, model API protocol, MCP transport. |
| **Bedrock runtime** | Same `AgentRuntime` contract via `converseStream` plus MCP client. Handles fast chat and interactive tool turns. | Durable worker ownership. |
| **AgentCore runtime** | Same `AgentRuntime` contract via Bedrock AgentCore Runtime. Handles durable chat, skill runs, schedules, and future app-build jobs. | Product state, user memory, schedule definitions, quota policy. |
| **MCP servers** (our code, one per system) | The auth handshake to a single system, a small surface of tools (`list_*`, `search_*`, `read_*`, `write_*`). HTTP transport for per-user delegated auth; stdio for M2M service-principal cases. | The agent loop, the model, the recipe definition, cross-system orchestration. |
| **Internal systems** | The actual data and side effects. | Anything about how AI Hub talks to them. |

## Product boundary: thin enterprise wrapper

AI Hub is not trying to rebuild Bedrock, M365, Salesforce, Workfront,
Databricks, specialized IDEs, or the foundation-model layer. Its job is to make
those capabilities safe and usable for normal employees by adding the thin
enterprise shell they do not get from the raw platforms.

AI Hub should own:
- the single front door and future enterprise SSO;
- tool connection UX, provider attestations, authorization checks, and token
  storage;
- recipes, schedules, run history, sharing, and discoverability;
- audit, redaction, retention, logging standards, quotas, and cost controls;
- the durable product data in Postgres: users, threads, messages, runs,
  tools, attestations, integration registry, and admin activity;
- the runtime seam that lets fast Bedrock turns and durable AgentCore turns
  share one product contract.

AI Hub should avoid owning:
- foundation model hosting or low-level model APIs;
- a generic orchestration framework before Bedrock/AgentCore patterns prove
  insufficient;
- a full coding IDE or app deployment platform before J1-J3 are proven;
- custom one-off integration shims when an MCP server can expose the same
  capability in an inspectable, reusable way.

The product rule for future work is: remove enterprise friction, do not
rebuild a platform unless AI Hub needs that layer for control, audit,
governance, user experience, or portability.

## AWS runtime capability matrix

This matrix captures the current J1-J3 runtime boundary after the June 2026
AWS-only simplification.

| Journey | Runtime supports | AI Hub must own | Current stance |
|---|---|---|---|
| **J1 Chat** | Bedrock streaming, model selection, direct text turns, cancellation at the product layer. | Auth, thread ownership, Postgres messages, bounded context, user settings, model labels, UI state, and runtime selection. | Supported. AI Hub supplies bounded prior context and keeps product memory in Postgres. |
| **J2 Chat with Tools** | Bedrock tool loop with MCP servers mounted per turn, streamed activity events, model dispatch. | Per-user OAuth token vault, provider/category/tool mount gating, audit rows, tool/result persistence, user-facing connection flows, and redaction. | Supported with constraints. Provider-admin approvals can expose broad provider tools; category/tool approvals only expose enabled catalog matches. |
| **J3 Scheduled Agents** | AgentCore worker execution through the same runtime seam. | Schedule definitions, worker/cron trigger, `runs`, idempotency, retries, timeouts, quotas, delivery destinations, reconnect UI, and failure handling. | Supported for time-based schedules; event/webhook triggers remain backlog. |

Do not assume the runtime owns enterprise scheduling, quota enforcement, data
retention, redaction, or long-term product memory. Bedrock/AgentCore is the AWS
runtime substrate; AI Hub is the enterprise control plane.

## Auth model

### Layer 1 — Identity into the shell

**POC (personal environment — current):** GitHub OAuth via NextAuth v4 with JWT strategy.

**Enterprise (required before GP production):** PingOne / PingFederate OIDC via NextAuth v4 (custom provider swap). The `users` table, `getSessionUser()`, all API routes, and the `ping_subject` column name are unchanged — `ping_subject` was always designed to hold the OIDC subject claim. The swap is a single NextAuth provider config change; no DB migration needed.

In both cases:
- `session.user.id` is the canonical `users.id` UUID (set in JWT callback via `token.userId = dbUser.id`).
- `users.ping_subject` stores the OAuth/OIDC subject claim for the identity provider in use.
- Admin status is `users.role = 'admin'` — set directly in the DB.
- `getSessionUser()` in `lib/auth/getSessionUser.ts` is the canonical user lookup: `WHERE id = session.user.id`. All API routes use this.

### Layer 2 — Shell → MCP servers (per-user delegated)

This layer is **independent of the identity provider** in Layer 1. It uses the same `oauth_tokens` table regardless of whether the user authenticated via GitHub or PingOne.

- For **delegated** systems (GitHub and Notion OAuth today; M365 / Salesforce / Workfront in future): the shell holds the user's OAuth tokens in `oauth_tokens` (AES-256-GCM encrypted with `OAUTH_ENCRYPTION_KEY`). At turn start it mints a short-lived access token and injects it into the MCP server's request as `Authorization: Bearer <token>`. **HTTP transport** is used so the header is per-request. Notion tool execution is mounted only when `NOTION_MCP_ENDPOINT_URL` points at a compatible gateway; the hosted Notion MCP performs its own OAuth handshake and is not used directly by this bearer-token path.
- For **service-principal / M2M** systems (Databricks, S3, Redshift): stdio transport with credentials in `mcpServers[].env` at process start.
- The tool gate checks `user_tool_attestations` and the tool catalog before
  MCP providers/tools are mounted for a turn.
- The chat route writes one `audit_log` row per MCP tool execution after each assistant message is persisted. Future hooks/admin routes can reuse the same ledger shape.

**Current OAuth apps in use (POC):**
1. `GITHUB_AUTH_CLIENT_ID` / `GITHUB_AUTH_CLIENT_SECRET` — sign-in identity app (NextAuth callback at `/api/auth/callback/github`). **Replaced by PingOne OIDC config in enterprise.**
2. `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — per-user GitHub MCP token app (callback at `/api/oauth/github/callback`). Scope: `repo read:user`. Stays as-is in enterprise — this is an MCP integration token, not the identity layer.
3. `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` — per-user Notion integration token app (callback at `/api/oauth/notion/callback`). This enables the Tools connection state and encrypted token storage; runtime mounting additionally requires `NOTION_MCP_ENDPOINT_URL`. Until that compatible gateway is configured, Notion is treated as linked but not model-callable so chat cannot overclaim read/write access.

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
1. **MCP servers are first-class.** A recipe declares which servers it needs. The shell mounts only those at agent start, so a "summarize my mail" recipe cannot reach GitHub even if the model tries.
2. **Attestations gate the catalog.** A user only sees recipes whose `mcp_server_slugs` intersect with tools they've attested to. The shipped chat path enforces this at provider mount time before the turn starts. Category/tool-scoped enforcement remains backlog work for a verified hook path or MCP proxy.

See [`ROADMAP.md`](./ROADMAP.md) for the use-case-driven view and the skills catalog flywheel.

## End-to-end request trace

Concrete example: user asks **"What PRs do I have open?"** in chat, GitHub MCP mounted.

1. **Browser → web container.** SSE POST to `/api/chat` with the thread id and the user's message. Cookie carries the NextAuth JWT. Today the container runs on App Runner; the enterprise target is ECS/Fargate.
2. **Shell** calls `getSessionUser(req)` → user row. Loads the `chat_threads` row, including the rolling `summary`, recent `chat_messages`, and the legacy `cursor_agent_id` column retained for migration compatibility only.
3. **Shell** loads the user's GitHub access token from `oauth_tokens`, mints a short-lived token if needed.
4. **Shell** calls `getRuntime().runTurn({...})` with the thread, message, model, and `mcp_server_slugs: ['github']`.
5. **Shell** builds bounded context with `buildTurnContext(...)`: rolling thread summary, the recent messages that still fit the configured count/size budget, and the user's current message. **BedrockRuntime** starts a streaming turn with that context.
6. **BedrockRuntime** mounts the GitHub MCP server (HTTP transport, per-turn `Authorization: Bearer <token>`). Begins the turn.
7. **Model** plans: `github.list_pull_requests(state='open', author='@me')`.
8. **MCP call** goes to `api.githubcopilot.com/mcp/` with the user's Bearer token. Returns the PR list.
9. **Model** assembles the answer. SSE events stream back through the shell to the browser.
10. **Shell** persists the assistant message to `chat_messages` with `model_id='sonnet-4-6'`, `runtime='bedrock'`, token metadata, structured tool calls/results, and one `audit_log` row per MCP tool execution. The schema and helper for rolling summaries exist; summary generation is still pending.

Durable work follows the same product steps but routes the runtime call through
the AgentCore worker lane instead of the inline Bedrock lane.

## Long-running runs and activity state

`recipe_runs` is the durable execution ledger for recipes, scheduled jobs,
chat-originated runs, and workflow-style agent turns. See
[`RUNS_DECISION.md`](./RUNS_DECISION.md) for the decision to keep one
generalized run ledger rather than split chat and recipe execution into
separate lifecycle tables. It stores the user,
optional future `recipe_id`, early `recipe_slug`, trigger type (`chat`,
`manual`, `scheduled`, etc.), runtime/model metadata, inputs, outputs, error
text, and lifecycle timestamps.

Every chat turn now creates a queued `recipe_runs` row with
`recipe_slug = chat-turn` and returns the run id to the browser immediately.
The runtime turn is executed by the chat-run worker path, not by the open
`/api/chat` request. The pilot web container starts an in-process worker for
immediate execution; the same queue consumer is packaged as a worker image for
ECS/Fargate. When the runtime accepts the turn, AI Hub stores provider/runtime
metadata in `outputs.providerRun` for visibility and debugging. Terminal runs
are folded back into `chat_messages` and marked succeeded/failed/canceled in
`recipe_runs`.
The chat UI exposes cancel for queued/running chat turns and retry for
failed/canceled turns. Admin run detail exposes the same chat-originated
controls plus a resume/reconcile action for queued/running runs that need to be
picked up by a worker again. These lifecycle actions update `recipe_runs`, write
append-only `run_events`, and record `audit_log` rows.

The chat surface now has the first user-facing activity timeline. During a
streaming turn, tool-call and tool-result events update a compact activity row
inside the assistant message. After refresh or reconnect, the same component is
rebuilt from `chat_messages.tool_calls/tool_results`, so completed tool work
remains visible even when the live SSE stream is gone. Network/browser stream
drops are labeled as connection loss rather than model failure.

`run_events` is the append-only reloadable progress stream keyed to
`recipe_runs.id`. Chat turns and the Developer Briefing workflow write
high-level lifecycle events plus redacted tool-call/tool-result events. Thread
history and admin run detail can replay those events after reconnect, so users
can see what a long-running agent was doing even when the browser stream is no
longer live.

Workflow runs use the same event shape. The Developer Briefing route stores
redacted `toolCalls` and `toolResults` in `recipe_runs.outputs` for terminal
output, writes `run_events` for reloadable progress, and writes `audit_log`
rows for compliance. The admin run detail page at `/admin/runs/[id]` reuses the
chat activity renderer and also shows the raw run-event timeline.

This is still a DB-backed queue, not the final AWS job system. The
production-grade deployment should attach the worker image to ECS/Fargate and
front it with SQS/EventBridge if direct DB polling is not enough for scale.
Step Functions remains reserved for explicit retry/wait-state audit
requirements. The important boundary is now clear: AgentCore owns durable
runtime execution; AI Hub owns identity, run state, leases, activity replay,
audit, retry/cancel policy, tool governance, and the enterprise user
experience.

## Audit ledger

`audit_log` is the central append-only compliance ledger. MCP tool execution is
the first producer: after a chat turn persists its assistant message, the route
writes one audit row per tool call/result with the actor, action type, status,
provider/tool names, tool-call id, links to the chat thread/message, input,
output or error payload, metadata, and lifecycle timestamps. Tool input/output
payloads are redacted before persistence. Future admin, recipe-run, and
security events reuse the same table.

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
chat turns enqueue transcript windows in `memory_capture_queue`. In the App
Runner pilot, the web process starts a single delayed memory-capture run 20
minutes after successful chats create queued work; if no transcript windows are
pending, the reviewer does not call the model. A dedicated memory-capture worker
image is also built for ECS/Fargate and can review pending windows in batches,
compare them against the existing Vault, and write proposed `user_memory_items`
with source thread/message provenance.

Vault renders approved memory as Markdown and shows suggested updates for
explicit user review. Users can approve, edit, dismiss, or archive suggestions.
Only `approved` memory is rendered into the compact Personal Context block that
the chat worker injects into future agent turns.

The next hardening layer is deeper governance: richer audit rows for approval
actions, admin retention policy, category-level visibility defaults, and moving
the pilot in-process scheduler to managed ECS/EventBridge infrastructure.

## MCP server registry

`mcp_servers` is the admin-curated registry of integrations AI Hub can mount.
Each row has a stable slug, display name, description, transport (`http`,
`sse`, or `stdio`), status (`active`, `disabled`, or `planned`), endpoint URL,
auth mode, timestamps, and free-form metadata. The initial migration seeds the
GitHub MCP server at `https://api.githubcopilot.com/mcp/` as an active HTTP
delegated-OAuth integration. Future providers can be added through registry
data first, then wired into OAuth/runtime behavior as they graduate.

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

Per-turn context assembly means AI Hub owns the context pack that gets sent to
the runtime. `buildTurnContext(...)` applies three deterministic
guardrails: `CHAT_RECENT_MESSAGE_LIMIT` bounds raw history count,
`CHAT_CONTEXT_CHAR_LIMIT` bounds total prompt context size, and
`CHAT_CONTEXT_MESSAGE_CHAR_LIMIT` bounds any single prior message or summary.
The current user message is always preserved exactly. When older history or a
summary is dropped/truncated, `/api/chat` emits a structured
`turn-context-guardrail` log with the thread, user, limit values, and retained
or dropped character counts.

## Hosting decision: ECS/Fargate with App Runner rollback

AI Hub should stay inside AWS for the enterprise path. That keeps the product
inside the platform family IT already understands, preserves the current
container build/deploy shape, and avoids introducing a separate hosting vendor
while the core question is still product value.

**Decision:** move the active deployment path to **ECS on Fargate** using the
existing ECR images and current RDS database first. App Runner remains a
temporary rollback host during cutover, but CodeBuild and runtime configuration
now target the CDK-managed ECS service set.

| Layer | Cutover target | Later hardening |
|---|---|---|
| Web runtime | ECS service on Fargate, `ai-workspace-web` | Scale-out after shared rate limiting |
| Workers | Separate ECS services for chat runs and Vault memory capture | Queue-backed dispatch if DB polling becomes limiting |
| Ingress | Application Load Balancer, ACM cert, Route 53 record at `comparative.builtwithrobot.link` with `ai-workspace.builtwithrobot.link` retained as a legacy alias | WAF/rate rules |
| Database | Existing RDS Postgres for fast cutover | RDS Proxy/Aurora and private DB posture |
| Secrets | AWS Secrets Manager JSON secret `ai-workspace/production/app` | KMS rotation policy |
| Networking | Default VPC for current RDS compatibility | Dedicated VPC/private subnets |
| Observability | CloudWatch logs/metrics/alarms, ALB health check on `/api/health` | Optional tracing |
| Edge controls | Minimal | ALB + WAF/rate rules when public enterprise traffic begins |
| IaC | CDK TypeScript in `infra/cdk` | Broaden to DB/proxy/edge resources |

This is not a reversal of the original thesis. App Runner was the right AWS
on-ramp for speed. ECS/Fargate is now the AWS-native version for IT review,
worker isolation, networking, IAM boundaries, observability, and 100k-user
planning.

## Enterprise scale posture

The current App Runner + RDS Postgres deployment is appropriate for the POC
and pilot path, but it is not yet a 100k-user architecture. The enterprise
target is ECS/Fargate with RDS Postgres, plus a required scale decision on RDS
Proxy and Aurora Postgres. Before enterprise scale, AI Hub needs explicit
decisions and tests for:

- request and tool-call quotas per user, team, provider, and model;
- body-size and max-output-token limits on `/api/chat`;
- DB connection pooling, likely RDS Proxy or equivalent pooling before large
  concurrency;
- health checks that include database and runtime dependency checks, not only
  process liveness;
- redaction and retention rules for `audit_log`, chat messages, tool inputs,
  and tool outputs;
- secrets management through AWS Secrets Manager/KMS and infrastructure as
  code;
- migration from App Runner to ECS/Fargate, starting with ECS Express Mode
  unless IT requires fully hand-authored ECS infrastructure from day one.

The current readiness decision record lives in
[`ENTERPRISE_READINESS.md`](./ENTERPRISE_READINESS.md). It documents the audit
triage, health check shape, process-local rate limits, retention/redaction
policy, Secrets Manager/KMS/IaC target, and 1k/10k/100k load-test model.

## Developer Briefing workflow

`POST /api/workflows/developer-briefing/run` is the first production-shaped
manual workflow route. It creates a `recipe_runs` row, mounts the user's
attested GitHub MCP server, builds a dated Developer Briefing prompt through
`lib/developer-briefing.ts`, and runs it through the same `AgentRuntime` seam as
chat. The prompt asks GitHub read tools to aggregate authored PRs,
review-requested PRs, stale PRs, and CI/check state into a fixed Markdown
briefing. The route stores structured output/failure state on the run, including
redacted `toolCalls`/`toolResults` for the shared activity UI, and writes
redacted tool execution audit rows linked by `recipe_run_id`.
Admins can inspect recent runs at `/admin/runs` and open `/admin/runs/[id]` to
review the stored briefing, activity timeline, redacted tool payloads, prompt,
and linked audit events. Failed or canceled Developer Briefing runs can be
retried from the run detail page; the retry creates a new `recipe_runs` row with
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
- **Identity model:** AI Hub `user_id` vs. GitHub username — the join table makes Athena queries work.
- **Schema evolution:** JSONL (fast start, harder to evolve) vs. Avro/Parquet + registry.

Until those are settled, Agent Wire stays as a stub in `mcp-servers/`; the S3 write path is a separate workstream.

## Migration path: ai-intake as Recipe 001

`ai-intake` (the prior internal AI intake tool) migrates as **Recipe 001** — the first non-trivial recipe in the catalog, deliberately chosen as a forcing function for every catalog feature without needing a new MCP server.

| ai-intake concept | Recipe equivalent |
|---|---|
| Form fields | `recipes.params_schema` (JSON Schema) |
| Form UI | Auto-generated from `params_schema` on `/recipes/:id/run` |
| System prompt | `recipes.system_prompt` |
| Model choice | `recipes.model_id` |
| Submit button | `getRuntime().runTurn(...)` with no MCP servers |
| Result page | `recipe_runs` row + standard run-detail UI |

Migration plan:
1. **Week 6:** port the ai-intake prompt into a `recipes` row. No MCP servers.
2. Run side by side for one release; compare outputs.
3. 301 the existing ai-intake URL to the recipe's run page. Archive the old repo after one quarter.
4. **Week 7+:** enrich with Graph MCP for context pull-in.

## Open questions

1. **AgentCore run durability.** Confirm reconnect/retry/cancel semantics under ECS task restarts and model/provider errors.
2. **Bedrock model access.** Sonnet and Haiku are enabled; Opus remains account-gated. Keep model picker labels honest when AWS account access changes.
3. **Short-lived per-turn vs. session-scoped tokens.** Current pattern: refresh per turn for each delegated MCP server. Alternative: cache session-scoped token in Redis with 50-minute TTL. Cost difference compounds with recipe scheduling. Decide before week 5.
4. **Catalog cold start.** Seed starter recipes ourselves (faster) or pair-author with 3 design-partner users (better recipes + adoption channel)? Decide end of week 5.
5. **Single Graph MCP vs. one server per surface.** Default: separate mail + calendar servers. Revisit after week 4 proves the pattern.
