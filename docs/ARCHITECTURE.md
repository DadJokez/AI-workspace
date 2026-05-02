# Architecture — AI Hub on the Cursor SDK runtime

> Companion to [`PLAN.md`](../PLAN.md) (the weekly ship plan) and
> [`SPIKE.md`](../SPIKE.md) (the runtime-pivot sandbox). This doc owns
> the end-state picture: what each layer does, who owns it, and how a
> request flows through it. Updated as decisions land.

## Vision

GP employees should have one front door for AI — a place to log in once
with their corporate identity and do anything they'd reasonably want to
do with an LLM against their own work data: chat with mail, calendar
and Teams; ask questions of Workfront and Salesforce; explore Databricks
and Redshift; schedule recurring briefings; assemble small workflows
("recipes") without thinking about which API, which token, which model.
The AI Hub is that front door. The model and the runtime are
**implementation details** that the user never sees; the experience is
"I asked, it answered, it cited what it touched." The architecture's
job is to make new integrations and new use cases additive — every new
MCP server multiplies the value of every existing recipe — without
re-platforming each time we add a system of record.

## Stack diagram

```
        ┌─────────────────────────────────────────────────────────┐
        │  User (browser / scheduled job / Teams card / email)    │
        └────────────────────────────┬────────────────────────────┘
                                     │  Ping OIDC session
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Enterprise Shell — apps/web (Next.js on Fargate)       │
        │   • Ping SSO + session                                  │
        │   • chat UI / recipes UI / tools catalog UI             │
        │   • persistence (RDS Postgres): threads, messages,      │
        │     recipes, runs, attestations, audit log              │
        │   • token vault (KMS-encrypted oauth_tokens)            │
        │   • policy layer (.cursor/hooks.json)                   │
        │   • /api/chat → AgentRuntime seam                       │
        └────────────────────────────┬────────────────────────────┘
                                     │  AgentRuntime.runTurn(...)
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Cursor SDK runtime (default)                           │
        │   • durable agents, streaming, tool-use protocol        │
        │   • model selection (Haiku / Sonnet / Opus)             │
        │   • mcpServers[] mounted per agent                      │
        │   • hooks fire preToolUse / postToolUse                 │
        │   ── fallback: BedrockRuntime (converseStream) ──       │
        └────────────────────────────┬────────────────────────────┘
                                     │  MCP (stdio | http+Bearer)
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  MCP servers (one per system of record)                 │
        │   teams · graph · workfront · databricks · salesforce   │
        │   redshift · servicenow · github · ado · agent-wire     │
        └────────────────────────────┬────────────────────────────┘
                                     │  vendor APIs
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Internal systems                                       │
        │   M365 / Salesforce / Workfront / Databricks / S3 /     │
        │   Redshift / ServiceNow / GitHub / ADO / SAP / …        │
        └─────────────────────────────────────────────────────────┘
```

## Component ownership

| Layer | Owns | Does not own |
|---|---|---|
| **User** | The intent. Picks the recipe or types the chat. | Tokens, model choice, transport. |
| **Enterprise Shell** (`apps/web`, our code) | Identity, persistence, audit, policy, UI, recipe storage, token vault. The seam (`AgentRuntime`) is the only thing it knows about the runtime. | Tool-use loop, model API protocol, MCP transport, durable agent state. |
| **Cursor SDK runtime** (Anysphere, vendored) | Durable agent state (`agentId`), streaming, tool-use protocol, model dispatch, MCP client. | Identity, business policy, persistence beyond the agent's own state. |
| **Bedrock runtime** (fallback) | Same `AgentRuntime` contract via `converseStream` + the existing `runAgentLoop`. Stateless turns; in-process tools today. | Durable agent state (turns are stateless). |
| **MCP servers** (our code, one per system) | The auth handshake to a single system, a small surface of tools (`list_*`, `search_*`, `read_*`, `write_*`), schema-on-tool. Stdio for service-principal / M2M cases; HTTP for per-user delegated cases (the `Authorization` header is injected per-turn). | The agent loop, the model, the recipe definition, cross-system orchestration. |
| **Internal systems** | The actual data and side effects. | Anything about how AI Hub talks to them. |

## Skills / recipes catalog

A **recipe** (or "skill" — same concept; naming will land with the
first business reviewer) is a row in `recipes` that materializes at
runtime into a Cursor agent definition:

```ts
{
  system_prompt: string,
  model_id:      'haiku-4-5' | 'sonnet-4-6' | 'opus-4-7',
  mcp_server_slugs: string[],   // e.g. ['graph', 'teams']
  allowed_tools: string[],      // pinned subset of the servers' tools
  params_schema: JSONSchema,    // user-supplied params at run time
  schedule_cron: string | null, // null = on-demand; cron = scheduled
}
```

Two things make this a catalog and not just "saved prompts":

1. **MCP servers are first-class.** A recipe declares which servers it
   needs. The shell mounts only those at agent start, so a "summarize
   my mail" recipe cannot reach Workfront even if the model tries.
2. **Attestations gate the catalog.** A user only sees recipes whose
   `mcp_server_slugs` intersect with tools they've attested to (or
   that were auto-attested via `graph_auto` from M365 license data).
   Same gate applies to chat tool calls via the `preToolUse` hook.

The flywheel is: every new MCP server expands the catalog's reach
without us touching the recipe code; every new recipe surfaces gaps
in MCP coverage that drive the next server. See
[`ROADMAP.md`](./ROADMAP.md) for the use-case-driven view.

## Three-layer auth flow

Authentication and authorization split cleanly across three layers,
each with a different lifetime and a different blast radius.

```
Layer 1: User → Shell           (PingOne OIDC, ~8h session)
Layer 2: Shell → Cursor          (process-scoped, no per-user identity)
Layer 3: Cursor → MCP server    (short-lived per-turn token; per-user)
```

### Layer 1 — Ping SSO into the shell

- PingOne / PingFederate OIDC via Auth.js v5 (custom provider).
- Session cookie, ~8 hours, httpOnly, Secure, SameSite=Lax.
- `users.ping_subject` is the identity of record. Email and display
  name are mirrored from the OIDC `userinfo` response.
- `getCurrentUser(req)` is the only place above the database that
  resolves "who is this." Hardcoded in week 1; session-derived from
  week 2 (PR #4 already shipped the shim).

### Layer 2 — Shell → Cursor SDK

- The Cursor SDK runs **in-process** inside the Fargate container. No
  network identity is needed for the shell→runtime hop.
- `CURSOR_API_KEY` (org-scoped) authenticates the SDK to the Cursor
  cloud control plane (model dispatch, durable-agent storage). It is
  **not** scoped per-user; it represents the AI Hub as a tenant.
- The user's identity is propagated as **agent metadata** on each
  `runTurn` call (`{ user_id, ping_subject, recipe_id }`) so the
  hooks layer can attribute every tool call back to a person.

### Layer 3 — Cursor → MCP servers (short-lived, per-user)

This is where per-user authorization actually lives.

- For **delegated** systems (M365 / Teams / Graph / Workfront /
  Salesforce): the shell holds the user's refresh token in
  `oauth_tokens` (KMS envelope-encrypted; `encrypted_dek` per row).
  At turn start, it mints a **short-lived access token** (≤1h) and
  injects it into the MCP server's request as `Authorization: Bearer
  <token>`. HTTP transport is used for these so the header is
  per-request, not process-fixed.
- For **service-principal / M2M** systems (Databricks via SP, S3,
  Redshift via IAM role, internal MCP servers like Agent Wire):
  stdio transport with credentials supplied via `mcpServers[].env`
  at process start. No per-user delegation.
- The `preToolUse` hook checks `user_tool_attestations` before the
  call goes out. If the user hasn't attested (and there's no auto-
  attest source like a Graph license), the call is denied and the
  agent gets a structured error it can recover from ("ask the user
  to enable this tool in their catalog").
- The `postToolUse` hook writes one `audit_log` row per call —
  `{user_id, server, tool, args_hash, result_hash, latency_ms, at}`.

If a refresh token is revoked, `oauth_tokens.needs_reauth = true`
flips the user's affected attestations to "needs reauth" in the UI.
Recipes referencing those servers go yellow until reconnected.

## End-to-end request trace

Concrete example: user asks **"What did Sara message me about the
Q3 launch, and is anything on my calendar tied to it?"** in chat,
on the Cursor runtime, with Teams MCP and Graph MCP both mounted.

1. **Browser → CloudFront → ALB → Fargate.** SSE POST to
   `/api/chat` with the thread id and the user's message. Cookie
   carries the Ping session.
2. **Shell** resolves `getCurrentUser(req)` → user row. Loads
   `chat_threads` row, including `cursor_agent_id` (may be NULL on
   the first Cursor-runtime turn for a thread).
3. **Shell** calls `getRuntime().runTurn({...})` with the thread,
   message, model, and `mcp_server_slugs: ['teams', 'graph']`.
4. **CursorRuntime** finds (or creates) the durable agent for this
   thread. If created, `cursor_agent_id` is persisted.
5. **Cursor SDK** mints short-lived Entra access tokens for Teams and
   Graph from the user's refresh tokens (the shell hands them in via
   the HTTP MCP server's per-turn `Authorization` header). Mounts
   both MCP servers. Begins the turn.
6. **Model** plans: it wants `teams.search_messages(from='Sara',
   topic='Q3 launch')` first.
7. **`preToolUse` hook** fires: checks `user_tool_attestations` for
   `(user_id, teams.search_messages)` → allowed. Hook returns
   `{ allow: true }`.
8. **MCP call** goes to the Teams MCP server (HTTP, with the
   short-lived Bearer token). Server hits the Graph API. Returns
   3 messages.
9. **`postToolUse` hook** writes an `audit_log` row.
10. **Model** plans the next step: `graph.list_calendar_events(
    from=now, to=+14d, contains='Q3')`. Same `preToolUse` →
    `postToolUse` round-trip.
11. **Model** assembles the answer with citations. SSE events stream
    back through the shell to the browser: tool-call cards render
    inline, the assistant text streams into the message bubble.
12. **Shell** persists the assistant message to `chat_messages` with
    `runtime='cursor'`, `model_id='sonnet-4-6'`, and the tool-call /
    tool-result JSON. `tokens_in`, `tokens_out`, `cost_usd_micros`
    are populated from the SDK's `usage` event.
13. If the same user re-asks tomorrow, the durable agent resumes
    from `cursor_agent_id` — no re-priming of context.

If `RUNTIME=bedrock` is set, steps 4–10 collapse into a stateless
`runAgentLoop` call against in-process tool functions. Steps 1–3 and
11–13 are identical. The chat route doesn't know which path ran.

## Agent Wire

**Agent Wire** is the planned internal tool that ingests
**Cursor + GitHub activity** (and eventually ADO, Codex, Claude Code,
and any other coding-agent telemetry) into **S3 + Athena** so we can
ask questions about how engineers actually use AI day-to-day. It's a
peer to the rest of the systems in the catalog — but it's also
structurally special, because it both **feeds** the AI Hub (as another
MCP server) and **observes** it (its own write path is `hooks.json`).

### Two roles

1. **Write path: `.cursor/hooks.json` is the producer.** Every
   `postToolUse` hook fires a structured event; today it goes to
   `audit_log` (Postgres). Agent Wire adds a second sink — append to
   an S3 prefix (`s3://gp-ai-hub-agent-wire/events/dt=YYYY-MM-DD/...`)
   in JSONL, partitioned by date. Athena is the query layer; Glue
   maintains the table. GitHub events arrive via a separate webhook
   path into the same S3 prefix — the schema is unified at the Athena
   layer.
2. **Read path: an Agent Wire MCP server.** Once the dataset has shape,
   we ship `packages/mcp-servers/agent-wire.ts` with tools like
   `query_engineer_activity`, `summarize_repo_velocity`,
   `top_skills_by_usage`, `find_underused_recipes`. This is what makes
   the catalog self-improving — recipes can ask the catalog about
   itself. ("What's the most-used recipe in my org? What MCP servers
   are slow today?")

### Why this matters for the catalog flywheel

The hardest part of running a recipe catalog at scale is **knowing
what's working**. Without Agent Wire we're guessing from `recipe_runs`
counts. With it, the catalog gets:

- "These three recipes are clones of the same pattern — promote a
  shared one." (clustering on recipe definitions + run params)
- "This MCP tool is called 12× per turn on average — it's probably
  too granular." (signal for tool-design refactors)
- "Engineers using Cursor + Claude Code are 3× more likely to ship
  PRs with passing CI on first push." (the kind of thing leadership
  asks for and we can't answer today)

### Schema review must precede MCP build

The S3/Athena schema is the load-bearing piece. **We need a schema
review before any of this gets wired up beyond the hook stub.** The
risk is the classic data-lake one: write the wrong shape now,
re-partition the world later. Specifically pin:

- **Event taxonomy.** What's an "agent activity event"? Does a single
  Cursor turn become one row (with N tool calls in a JSON column) or
  N+1 rows? Today's `audit_log` is the latter; for analytics, the
  former is usually right. Pick one before backfilling.
- **PII and retention.** Tool args can include user content. Hash or
  truncate at write time, not at read time. Define a TTL policy
  (S3 lifecycle → Glacier → expire) before we have anything to
  delete.
- **Identity model.** `user_id` is the AI Hub's. GitHub activity uses
  GitHub usernames. The join table (or mapping in `users`) is the
  thing that makes the Athena queries work. Decide who owns it.
- **Schema evolution.** Avro / Parquet with a registry, or JSONL
  with discipline? JSONL is faster to start, harder to evolve.

Until that's settled, Agent Wire stays as a `mcp-servers/` stub like
the others; the hook stays a no-op write to `audit_log`; and the
write-path-to-S3 is **a separate workstream** with its own RFC.

## Migration path: ai-intake as Recipe 001

`ai-intake` is the prior internal AI form-style intake tool — a
flow where users fill in a structured form, an LLM does some
templated reasoning, and an answer / artifact comes back. It works
today, but it's a one-off: its own UI, its own auth, its own
deployment, no integration with anything downstream.

We migrate it as **Recipe 001** in the new catalog, deliberately as
the first non-trivial recipe, because it's a forcing function for
every catalog feature without needing any new MCP server:

| ai-intake concept | Recipe equivalent |
|---|---|
| The form fields | `recipes.params_schema` (JSON schema) |
| The form UI | Auto-generated from `params_schema` on `/recipes/:id/run` |
| The system prompt | `recipes.system_prompt` |
| The model choice | `recipes.model_id` |
| "Submit" button | `getRuntime().runTurn(...)` with no MCP servers |
| The result page | `recipe_runs` row + the standard run-detail UI |
| Email-the-result | SES on completion (week 5+ scheduling path reused) |

The migration plan:

1. **Week 6** (recipes catalog ships): port the ai-intake prompt
   verbatim into a `recipes` row. No MCP servers attached. The
   form UI is auto-rendered from `params_schema`.
2. Run **side by side** with the existing ai-intake for one
   release. Compare outputs on a fixed eval set.
3. Cut over the existing ai-intake URL with a 301 to the recipe's
   run page. Keep the ai-intake repo around for one quarter,
   then archive.
4. **Week 7+**: enrich the recipe — add Graph MCP for context
   pull-in ("what mail does the requester already have on this
   topic?"), add `schedule_cron` if we want it as a weekly batch,
   etc. This is the part that was structurally impossible before.

The point of doing this first: **the ai-intake migration proves the
catalog can absorb an existing production use case without bespoke
code.** If the recipe abstraction can't host ai-intake, it's the
wrong abstraction. Better to find that out at week 6 than week 26.

## Open questions

1. **Data residency.** Cursor's cloud control plane stores durable
   agent state. Where? Under what contract? GP data classification
   may rule out US-only storage for some content (HR, certain
   customer data). If so, we either run **local-only** Cursor
   agents (the SDK supports it; cloud features like cross-device
   resume are lost) or fall back to `RUNTIME=bedrock` for those
   recipes. This needs a written answer from Anysphere before
   week 8 hardening.
2. **Cursor SLA and surface stability.** v1.0.12 published
   2026-05-01. There's no published SLA yet. `Agent.get` is
   cloud-only with local lookup deferred. If Anysphere ships a
   breaking change between weeks 3 and 8, do we pin to a specific
   minor and accept the security-patch lag, or float and accept
   churn? The `RUNTIME=bedrock` fallback is the insurance policy
   either way, but the policy needs to be written down.
3. **Token design — short-lived per-turn vs. session-scoped.**
   The plan says "short-lived per-turn" Bearer tokens injected
   into HTTP MCP servers. The cost: a refresh per turn for every
   delegated MCP server. The alternative: cache a session-scoped
   token in Redis with a 50-minute TTL, refresh lazily. Decide
   before week 4 (Graph) — the cost difference compounds with
   recipe scheduling.
4. **Catalog cold start.** A catalog with two recipes is not a
   catalog. The week-6 ship is "users can create their own", but
   adoption depends on **starter recipes** that are immediately
   useful. Open question: do we seed it ourselves (Rob writes 5–10
   recipes covering Meeting Prep, Weekly Status, etc.) or do we
   pick 3 design-partner users and pair-author with them? The
   latter generates better recipes and an adoption channel; the
   former ships faster. Decide by end of week 5.
