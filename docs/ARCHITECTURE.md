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
        │  Cursor SDK runtime (default — RUNTIME=cursor)          │
        │   • streaming, tool-use protocol, MCP client            │
        │   • model selection (Haiku / Sonnet / Opus)             │
        │   • mcpServers[] mounted per agent                      │
        │   • hooks available for future observation/control      │
        │   ── fallback: BedrockRuntime (RUNTIME=bedrock) ────── │
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
| **Cursor SDK runtime** | Streaming, tool-use protocol, model dispatch, MCP client. Current production flow starts a fresh runtime turn and receives bounded context from the shell. | Identity, business policy, Postgres persistence, long-term conversation memory. |
| **Bedrock runtime** (fallback) | Same `AgentRuntime` contract via `converseStream`. Stateless turns. | Durable agent state (turns are stateless). |
| **MCP servers** (our code, one per system) | The auth handshake to a single system, a small surface of tools (`list_*`, `search_*`, `read_*`, `write_*`). HTTP transport for per-user delegated auth; stdio for M2M service-principal cases. | The agent loop, the model, the recipe definition, cross-system orchestration. |
| **Internal systems** | The actual data and side effects. | Anything about how AI Hub talks to them. |

## Product boundary: thin enterprise wrapper

AI Hub is not trying to rebuild Cursor, Bedrock, M365, Salesforce,
Workfront, Databricks, or the foundation-model layer. Its job is to make
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
- the runtime seam that lets Cursor stay the default while Bedrock remains a
  fallback.

AI Hub should avoid owning:
- foundation model hosting or low-level model APIs;
- a generic orchestration framework when Cursor already supplies the agent
  loop;
- a full coding IDE or app deployment platform before J1-J3 are proven;
- custom one-off integration shims when an MCP server can expose the same
  capability in an inspectable, reusable way.

The product rule for future work is: remove enterprise friction, do not
rebuild a platform unless AI Hub needs that layer for control, audit,
governance, user experience, or portability.

## Cursor SDK capability matrix

This matrix captures the current J1-J3 runtime boundary for `@cursor/sdk`
v1.0.13 and Cursor's public SDK guidance from April 2026.

| Journey | Cursor SDK supports | AI Hub must own | Current stance |
|---|---|---|---|
| **J1 Chat** | `Agent.create`, `agent.send`, model selection, `run.stream()`, cancellation, and local/cloud execution options. | Auth, thread ownership, Postgres messages, bounded context, user settings, model labels, UI state, and fallback runtime selection. | Supported. Fresh-agent-per-turn remains the default; AI Hub supplies bounded prior context instead of depending on Cursor for product memory. |
| **J2 Chat with Tools** | MCP servers passed inline or loaded from Cursor config; HTTP/SSE/stdio MCP shapes are represented by the SDK; streamed run events expose tool activity enough for the chat activity timeline. | Per-user OAuth token vault, provider-level mount gating, audit rows, tool/result persistence, lower-level tool/category policy, user-facing connection flows, and redaction. | Supported with constraints. The current gate controls whether a provider is mounted. Tool/category enforcement is not yet enforced by `.cursor/hooks.json`; it needs a verified hook workflow or an MCP proxy. |
| **J3 Scheduled Agents** | Programmatic agent runs can be started by backend code, streamed, waited on, cancelled, and tied to the same runtime seam. | Schedule definitions, worker/cron trigger, `recipe_runs`, idempotency, retries, timeouts, quotas, delivery destinations, reconnect UI, and failure handling. | Feasible, but not a Cursor feature by itself. Treat scheduling as an AI Hub control-plane layer around the SDK. |

For short interactive chat, `CURSOR_RUNTIME_MODE=local` preserves the current
behavior: the Cursor SDK run lives in the web container and streams directly to
the browser. For long work, `CURSOR_RUNTIME_MODE=cloud` dispatches to Cursor
Cloud. The SDK exposes provider-side `agentId`/`runId`, `Agent.getRun(...)`,
`run.wait()`, and `run.conversation()`, so AI Hub can rehydrate a run after a
browser disconnect or App Runner's 120-second HTTP timeout. The control-plane
record still lives in AI Hub's generalized run ledger (`recipe_runs` for now).

Do not assume Cursor owns enterprise scheduling, quota enforcement, data
retention, redaction, or long-term product memory. Cursor is the runtime
harness; AI Hub is the enterprise control plane.

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

- For **delegated** systems (GitHub today; M365 / Salesforce / Workfront in future): the shell holds the user's OAuth tokens in `oauth_tokens` (AES-256-GCM encrypted with `OAUTH_ENCRYPTION_KEY`). At turn start it mints a short-lived access token and injects it into the MCP server's request as `Authorization: Bearer <token>`. **HTTP transport** is used so the header is per-request.
- For **service-principal / M2M** systems (Databricks, S3, Redshift): stdio transport with credentials in `mcpServers[].env` at process start.
- The tool gate checks `user_tool_attestations` before MCP providers are mounted for a turn.
- The chat route writes one `audit_log` row per MCP tool execution after each assistant message is persisted. Future hooks/admin routes can reuse the same ledger shape.

**Current OAuth apps in use (POC):**
1. `GITHUB_AUTH_CLIENT_ID` / `GITHUB_AUTH_CLIENT_SECRET` — sign-in identity app (NextAuth callback at `/api/auth/callback/github`). **Replaced by PingOne OIDC config in enterprise.**
2. `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — per-user GitHub MCP token app (callback at `/api/oauth/github/callback`). Scope: `repo read:user`. Stays as-is in enterprise — this is an MCP integration token, not the identity layer.

## Recipes / skills catalog

A **recipe** (or "skill" — same concept; naming TBD) is a row in `recipes` that materializes at runtime into a Cursor agent definition:

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
2. **Shell** calls `getSessionUser(req)` → user row. Loads the `chat_threads` row, including the rolling `summary`, recent `chat_messages`, and the `cursor_agent_id` retained for visibility/backward compatibility.
3. **Shell** loads the user's GitHub access token from `oauth_tokens`, mints a short-lived token if needed.
4. **Shell** calls `getRuntime().runTurn({...})` with the thread, message, model, and `mcp_server_slugs: ['github']`.
5. **Shell** builds bounded context with `buildTurnContext(...)`: rolling thread summary, the recent messages that still fit the configured count/size budget, and the user's current message. **CursorRuntime** starts a fresh runtime turn with that context.
6. **Cursor SDK** mounts the GitHub MCP server (HTTP transport, per-turn `Authorization: Bearer <token>`). Begins the turn.
7. **Model** plans: `github.list_pull_requests(state='open', author='@me')`.
8. **MCP call** goes to `api.githubcopilot.com/mcp/` with the user's Bearer token. Returns the PR list.
9. **Model** assembles the answer. SSE events stream back through the shell to the browser.
10. **Shell** persists the assistant message to `chat_messages` with `model_id='sonnet-4-6'`, `runtime='cursor'`, token metadata, structured tool calls/results, and one `audit_log` row per MCP tool execution. The schema and helper for rolling summaries exist; summary generation is still pending.

If `RUNTIME=bedrock` is set, steps 5–8 collapse into a stateless `runAgentLoop` call. Steps 1–4 and 9–10 are identical.

## Long-running runs and activity state

`recipe_runs` is the durable execution ledger for recipes, scheduled jobs,
chat-originated runs, and workflow-style agent turns. See
[`RUNS_DECISION.md`](./RUNS_DECISION.md) for the decision to keep one
generalized run ledger rather than split chat and recipe execution into
separate lifecycle tables. It stores the user,
optional future `recipe_id`, early `recipe_slug`, trigger type (`chat`,
`manual`, `scheduled`, etc.), runtime/model metadata, inputs, outputs, error
text, and lifecycle timestamps.

Every chat turn now creates a `recipe_runs` row with `recipe_slug = chat-turn`
before the runtime starts. When Cursor accepts the turn, AI Hub stores the
provider-side Cursor agent/run ids in `outputs.providerRun`. For local Cursor
runs this is visibility only; for Cursor Cloud runs it is a recovery handle. If
the browser stream is gone, reopening the thread reconciles old running cloud
runs with `Agent.getRun(...)`. Terminal cloud runs are folded back into
`chat_messages` and marked succeeded/failed/canceled in `recipe_runs`.

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

This is still a bridge, not the final job system. The production-grade version
of #89 should move execution and reconciliation into an ECS/Fargate worker (or
SQS/EventBridge/Step Functions path). The important boundary is now clear:
Cursor Cloud owns durable agent execution; AI Hub owns identity, run state,
activity replay, audit, retry/cancel policy, tool governance, and the
enterprise user experience.

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
optional tool-catalog linkage. Revocation is modeled by stamping `revoked_at`
and `revoked_by` instead of deleting the approval history. The future
tool gate queries active rows (`revoked_at IS NULL`) by user and provider
before mounting MCP servers for the turn. Denied providers are written to the
audit log with `status='denied'`. Category/tool-scoped rows are preserved for
the future lower-level MCP proxy, where individual tool calls can be filtered
without exposing an entire provider.

## Prompt guardrails

Fresh-agent-per-turn execution means AI Hub owns the context pack that gets
sent to the runtime. `buildTurnContext(...)` applies three deterministic
guardrails: `CHAT_RECENT_MESSAGE_LIMIT` bounds raw history count,
`CHAT_CONTEXT_CHAR_LIMIT` bounds total prompt context size, and
`CHAT_CONTEXT_MESSAGE_CHAR_LIMIT` bounds any single prior message or summary.
The current user message is always preserved exactly. When older history or a
summary is dropped/truncated, `/api/chat` emits a structured
`turn-context-guardrail` log with the thread, user, limit values, and retained
or dropped character counts.

## Hosting decision: App Runner pilot, ECS/Fargate enterprise

AI Hub should stay inside AWS for the enterprise path. That keeps the product
inside the platform family IT already understands, preserves the current
container build/deploy shape, and avoids introducing a separate hosting vendor
while the core question is still product value.

**Decision:** keep App Runner for the current POC/pilot, but target
**ECS on Fargate** for the enterprise production architecture. ECS Express
Mode is the preferred first migration path because AWS positions it as the
App Runner migration target and it preserves much of App Runner's simplicity
while creating a normal ECS/Fargate service, load balancer, autoscaling, and
networking stack in our AWS account.

| Layer | Pilot / current | Enterprise target |
|---|---|---|
| Web runtime | App Runner service using the existing Docker image | ECS service on Fargate, likely created first with ECS Express Mode |
| Ingress | App Runner URL / future custom domain | Application Load Balancer, ACM cert, optional Route 53 weighted migration |
| Database | RDS Postgres | RDS Postgres for near term; evaluate RDS Proxy and Aurora Postgres before broad rollout |
| Secrets | App Runner environment variables | AWS Secrets Manager + KMS; task role reads secrets at runtime |
| Networking | App Runner-managed | VPC/subnets/security groups owned in IaC; private DB access |
| Observability | App Runner/CodeBuild logs | CloudWatch logs/metrics/alarms, ALB metrics, ECS service metrics, optional tracing |
| Edge controls | Minimal | ALB + WAF/rate rules when public enterprise traffic begins |
| IaC | Manual/CodeBuild-era setup | Terraform/CDK/CloudFormation for ECS, ALB, IAM, Secrets Manager/KMS, RDS, alarms |

This is not a reversal of the original thesis. App Runner was the right AWS
on-ramp for speed. ECS/Fargate is the AWS-native grown-up version for IT
review, networking, IAM boundaries, observability, and 100k-user planning.

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

## Agent Wire

**Agent Wire** is planned tooling to ingest Cursor + GitHub activity into S3 + Athena so we can ask questions about how engineers actually use AI. It is both a write path (`.cursor/hooks.json` is the producer) and a read path (an `agent-wire` MCP server). The S3/Athena schema must be reviewed before any of this gets wired up beyond the current stub.

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

1. **Cursor data residency.** Anysphere may store runtime-side agent state and tool transcripts. AI Hub keeps bounded conversation context in Postgres, but GP data classification still needs a written answer from Anysphere before week 8 hardening.
2. **Cursor SDK SLA and surface stability.** No published SLA as of v1.0.12 (May 2026). `RUNTIME=bedrock` is the insurance policy. Policy on version pinning vs. floating TBD.
3. **Short-lived per-turn vs. session-scoped tokens.** Current pattern: refresh per turn for each delegated MCP server. Alternative: cache session-scoped token in Redis with 50-minute TTL. Cost difference compounds with recipe scheduling. Decide before week 5.
4. **Catalog cold start.** Seed starter recipes ourselves (faster) or pair-author with 3 design-partner users (better recipes + adoption channel)? Decide end of week 5.
5. **Single Graph MCP vs. one server per surface.** Default: separate mail + calendar servers. Revisit after week 4 proves the pattern.
