# Spike: Cursor SDK as agent runtime

**Branch:** `spike/cursor-sdk-runtime` (off `main` at 7d2ff0f)
**Status:** sandbox — not for merge
**Date opened:** 2026-05-02

## Why this branch exists

The architecture in [`PLAN.md`](./PLAN.md) commits to AWS Bedrock as the
runtime, with in-process tool functions and MCP deferred to week 8+. A
question came up about whether we should instead use the Cursor SDK
(`@cursor/sdk`, published by Anysphere) as the runtime engine, with our
app providing the enterprise shell — Ping SSO, MCP servers for internal
systems, a recipes/skills catalog.

That's a real architectural fork. Rather than answer it on a slide deck,
this branch sketches the seam in code so we can see what it would actually
look like — and what it would actually cost to promote.

**Main is untouched.** The Bedrock implementation that landed in PRs #5–#8
is intact; this branch only adds new packages alongside it.

## What's here

```
.cursor/
  hooks.json                  no-op hook skeleton (preToolUse, postToolUse, ...)
packages/
  cursor-runtime/             the runtime seam
    src/
      types.ts                AgentRuntime interface, TurnInput, RuntimeName
      bedrock-runtime.ts      adapter wrapping the existing runAgentLoop
      cursor-runtime.ts       Cursor SDK adapter (stub — throws on .runTurn)
      factory.ts              getRuntime() reads RUNTIME env var
      index.ts
  mcp-servers/                placeholder MCP servers
    src/
      workfront.ts            McpServerConfigStub + start() stub
      databricks.ts           same shape
      teams.ts                same shape
      index.ts
    README.md
SPIKE.md                      this file
apps/web/.env.example         documents RUNTIME and CURSOR_API_KEY (not yet wired)
```

## What's not here (deliberate)

- **No changes to `apps/web/`** beyond `.env.example`. The chat route
  still calls `runAgentLoop` directly. Wiring it through `getRuntime()`
  is part of promotion, not the spike.
- **No `@cursor/sdk` install.** The package is real (confirmed on npm —
  `@cursor/sdk@1.0.12`, Anysphere) but it's a 12 MB unpacked dep with a
  `sqlite3` native binding. We don't want it gating `pnpm install` for
  every contributor on `main` until the architectural decision is made.
  The import line in [`cursor-runtime.ts`](./packages/cursor-runtime/src/cursor-runtime.ts)
  is commented out with the real surface documented in the comment.
- **No MCP server implementations.** Stubs only — see
  [`packages/mcp-servers/README.md`](./packages/mcp-servers/README.md).
- **No real hook policies.** The skeleton at
  [`.cursor/hooks.json`](./.cursor/hooks.json) just establishes the file
  location and shape.

## Architecture direction (if promoted)

```
                    ┌─────────────────────────────────┐
                    │ apps/web (Next.js, Fargate)     │
                    │   - Ping OIDC SSO               │
                    │   - chat UI / recipes UI        │
                    │   - /api/chat → AgentRuntime    │
                    └──────────────┬──────────────────┘
                                   │
                       (RUNTIME env: bedrock | cursor)
                                   │
                    ┌──────────────┴──────────────────┐
                    │       AgentRuntime (seam)       │
                    └──────┬──────────────────┬───────┘
                           │                  │
            ┌──────────────▼──────┐   ┌───────▼─────────────────┐
            │ BedrockRuntime      │   │ CursorRuntime           │
            │  - runAgentLoop     │   │  - @cursor/sdk          │
            │  - in-process tools │   │  - durable agents       │
            │  - stateless turns  │   │  - MCP servers          │
            │                     │   │  - .cursor/hooks.json   │
            └─────────────────────┘   └────┬────────────────────┘
                                           │
                            ┌──────────────┼──────────────┐
                            │              │              │
                      ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
                      │ Workfront │  │ Databricks│  │   Teams   │
                      │   MCP     │  │   MCP     │  │   MCP     │
                      └───────────┘  └───────────┘  └───────────┘
```

The pitch:

- Cursor SDK owns the **runtime** — durable agent state, streaming,
  tool-use protocol, model selection. We don't reimplement any of it.
- Our app owns the **enterprise shell** — Ping SSO, persistence (chat
  history, recipes, audit log), the policy layer (`.cursor/hooks.json`),
  and the MCP servers that expose internal systems.
- Recipes/skills become Cursor agent definitions with locked-down
  `mcpServers` and `systemPrompt`, persisted in our DB.

## What this seam buys us

1. **Single env-var swap.** `RUNTIME=bedrock` and `RUNTIME=cursor` both
   produce an `AgentRuntime`. `apps/web/app/api/chat/route.ts` (when
   updated) only ever sees the interface.
2. **Bedrock work isn't wasted.** `BedrockRuntime` is a thin wrapper
   over the existing `runAgentLoop` — same code path, new boundary.
3. **MCP migration is mechanical.** Tools currently registered via
   `ToolRegistry` map directly onto MCP server tools. The
   `packages/mcp-servers/` stubs document where each one would land.

## What this seam costs

1. **One more abstraction layer.** Today the chat route calls
   `runAgentLoop` directly. Promoting this adds a `getRuntime()` call in
   between. Cheap, but real.
2. **Persistence schema change.** Cursor agents are durable and have
   their own `agentId`. We need a column on `chat_threads` to store the
   mapping (`cursor_agent_id text`). Migration is small but needs a
   plan for existing rows (NULL = create-on-next-turn).
3. **The Cursor SDK is young.** v1.0.12 published 2026-05-01. Surface
   is still moving — `Agent.get` is documented as cloud-only, local
   agent lookup is "post-launch followup". Promotion means accepting
   that risk.

## Promotion checklist

If we decide to promote this to main:

- [ ] **Decision document.** Update `PLAN.md` to reflect the runtime
      pivot, including the impact on weeks 3–7 (Graph integration moves
      from in-process tools to a Graph MCP server; recipes wrap Cursor
      agent definitions instead of system prompts).
- [ ] **Install `@cursor/sdk`.** Add to
      `packages/cursor-runtime/package.json` and confirm `pnpm install`
      still works on CI (`sqlite3` native build is the risk).
- [ ] **Implement `CursorRuntime.runTurn`.** Replace the throw with the
      sketch in the file's comments. Wire `signal`, `usage`, and stop
      reasons through to `AgentEvent`.
- [ ] **Persist the `threadId → agentId` mapping.** Drizzle migration
      adding `chat_threads.cursor_agent_id`. Implement
      `ThreadAgentStore` against the DB (replace
      `InMemoryThreadAgentStore`).
- [ ] **Wire `getRuntime()` into the chat route.** Single edit in
      `apps/web/app/api/chat/route.ts` — replace the direct
      `runAgentLoop` call with `getRuntime().runTurn(...)`.
- [ ] **Implement the first MCP server end-to-end.** Probably Teams,
      since it reuses the Entra OAuth path PLAN.md already calls for.
      One server proves the pattern; the rest follow.
- [ ] **Pick a real hook.** `.cursor/hooks.json` is no-op today. First
      real hook is probably `postToolUse → audit_log writer`.
- [ ] **Update `AWS_SETUP.md` and `README.md`.** Bedrock setup remains
      relevant (still the fallback runtime); add a parallel Cursor SDK
      setup section.
- [ ] **Decide what happens to `runAgentLoop`.** Keep as the Bedrock
      backend forever, or sunset once Cursor is proven? Don't decide
      this until we've run on Cursor for a real workload.

## How to evaluate this branch

```bash
git checkout spike/cursor-sdk-runtime
pnpm install
pnpm typecheck    # should pass; the spike compiles without @cursor/sdk
pnpm lint
```

Read in this order:

1. [`packages/cursor-runtime/src/types.ts`](./packages/cursor-runtime/src/types.ts) —
   the contract.
2. [`packages/cursor-runtime/src/cursor-runtime.ts`](./packages/cursor-runtime/src/cursor-runtime.ts) —
   what the real implementation would look like (in comments).
3. [`packages/cursor-runtime/src/bedrock-runtime.ts`](./packages/cursor-runtime/src/bedrock-runtime.ts) —
   shows the existing loop fits behind the same interface.
4. [`packages/mcp-servers/README.md`](./packages/mcp-servers/README.md) —
   what each internal system MCP server would expose.

## Decision

_To be filled in by Rob after review._
