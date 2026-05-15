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
        │  Enterprise Shell — apps/web (Next.js on App Runner)    │
        │   • Auth: GitHub OAuth (POC) → PingOne OIDC (enterprise)│
        │   • chat UI / recipes UI / tools catalog UI             │
        │   • persistence (RDS Postgres): threads, messages,      │
        │     recipe runs, audit log, tools, future recipes/authz │
        │   • token vault (AES-256-GCM encrypted oauth_tokens)   │
        │   • policy layer (.cursor/hooks.json)                   │
        │   • /api/chat → AgentRuntime seam                       │
        └────────────────────────────┬────────────────────────────┘
                                     │  AgentRuntime.runTurn(...)
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │  Cursor SDK runtime (default — RUNTIME=cursor)          │
        │   • streaming, tool-use protocol, MCP client            │
        │   • model selection (Haiku / Sonnet / Opus)             │
        │   • mcpServers[] mounted per agent                      │
        │   • hooks available for future policy enforcement       │
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
| **Enterprise Shell** (`apps/web`) | Identity, persistence, audit, policy, UI, recipe storage, token vault, rolling thread summaries, and bounded context assembly. The seam (`AgentRuntime`) is the only thing it knows about the runtime. | Tool-use loop, model API protocol, MCP transport. |
| **Cursor SDK runtime** | Streaming, tool-use protocol, model dispatch, MCP client. Current production flow starts a fresh runtime turn and receives bounded context from the shell. | Identity, business policy, Postgres persistence, long-term conversation memory. |
| **Bedrock runtime** (fallback) | Same `AgentRuntime` contract via `converseStream`. Stateless turns. | Durable agent state (turns are stateless). |
| **MCP servers** (our code, one per system) | The auth handshake to a single system, a small surface of tools (`list_*`, `search_*`, `read_*`, `write_*`). HTTP transport for per-user delegated auth; stdio for M2M service-principal cases. | The agent loop, the model, the recipe definition, cross-system orchestration. |
| **Internal systems** | The actual data and side effects. | Anything about how AI Hub talks to them. |

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
- The `preToolUse` hook will check `user_tool_attestations` before the call goes out (wired in Week 7).
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
2. **Attestations gate the catalog.** A user only sees recipes whose `mcp_server_slugs` intersect with tools they've attested to. Same gate applies to chat tool calls via the `preToolUse` hook.

See [`ROADMAP.md`](./ROADMAP.md) for the use-case-driven view and the skills catalog flywheel.

## End-to-end request trace

Concrete example: user asks **"What PRs do I have open?"** in chat, GitHub MCP mounted.

1. **Browser → App Runner.** SSE POST to `/api/chat` with the thread id and the user's message. Cookie carries the NextAuth JWT.
2. **Shell** calls `getSessionUser(req)` → user row. Loads the `chat_threads` row, including the rolling `summary`, recent `chat_messages`, and the `cursor_agent_id` retained for visibility/backward compatibility.
3. **Shell** loads the user's GitHub access token from `oauth_tokens`, mints a short-lived token if needed.
4. **Shell** calls `getRuntime().runTurn({...})` with the thread, message, model, and `mcp_server_slugs: ['github']`.
5. **Shell** builds bounded context with `buildTurnContext(...)`: rolling thread summary, the recent messages that still fit the budget, and the user's current message. **CursorRuntime** starts a fresh runtime turn with that context.
6. **Cursor SDK** mounts the GitHub MCP server (HTTP transport, per-turn `Authorization: Bearer <token>`). Begins the turn.
7. **Model** plans: `github.list_pull_requests(state='open', author='@me')`.
8. **MCP call** goes to `api.githubcopilot.com/mcp/` with the user's Bearer token. Returns the PR list.
9. **Model** assembles the answer. SSE events stream back through the shell to the browser.
10. **Shell** persists the assistant message to `chat_messages` with `model_id='sonnet-4-6'`, `runtime='cursor'`, token metadata, structured tool calls/results, and one `audit_log` row per MCP tool execution. It then refreshes the thread summary.

If `RUNTIME=bedrock` is set, steps 5–8 collapse into a stateless `runAgentLoop` call. Steps 1–4 and 9–10 are identical.

## Long-running runs and activity state

`recipe_runs` is the durable execution ledger for recipes, scheduled jobs,
and workflow-style agent turns. It stores the user, optional future
`recipe_id`, early `recipe_slug`, trigger type (`manual`, `scheduled`, etc.),
runtime/model metadata, inputs, outputs, error text, and lifecycle timestamps.

The user-facing activity timeline is a follow-on to this foundation: each
long turn should show visible progress states such as thinking, calling tools,
running a workflow step, saving output, reconnecting, and finished/failed. The
timeline events will hang off this run record or a sibling event table once the
first scheduled/workflow route lands.

## Audit ledger

`audit_log` is the central append-only compliance ledger. MCP tool execution is
the first producer: after a chat turn persists its assistant message, the route
writes one audit row per tool call/result with the actor, action type, status,
provider/tool names, tool-call id, links to the chat thread/message, input,
output or error payload, metadata, and lifecycle timestamps. Future admin,
recipe-run, and security events reuse the same table.

## Tools catalog

`tools_catalog` is the admin-curated, user-visible inventory of MCP tools. It
maps provider-native tool names such as GitHub tools to display names,
descriptions, categories, read/write/admin action levels, attestation
requirements, enabled/disabled state, and optional metadata. It intentionally
uses `provider + tool_name` before the MCP server registry exists, so live
GitHub tools can be cataloged now and later linked to richer server records.

## Tool attestations

`user_tool_attestations` records each user's explicit approval for a provider,
category, or individual tool. Rows preserve who approved the scope, when it was
approved, the maximum action level covered (`read`, `write`, or `admin`), and
optional tool-catalog linkage. Revocation is modeled by stamping `revoked_at`
and `revoked_by` instead of deleting the approval history. The future
`preToolUse` gate can query active rows (`revoked_at IS NULL`) by user,
provider, category, tool name, or catalog id.

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
