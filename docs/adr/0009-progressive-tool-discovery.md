# ADR 0009: Progressive tool discovery via stable bundles + sticky activation

- **Status:** Accepted
- **Date:** 2026-07-19
- **Deciders:** Rob (owner), Claude/Codex (implementation)

## Context
Model-decided routing mounts the user's full tool catalog on every turn — 72 tools in production, of which GitHub alone is 44 schemas and ~73% of ~59.8K schema chars, so a 3-char greeting paid a ~21.5K-token cache write and sat past the ~30–50-tool knee where selection precision degrades (`docs/PROGRESSIVE_TOOL_DISCOVERY_SPEC.md:8-16`). Bedrock's cache hierarchy is tools → system → messages, so any change to the mounted tool set invalidates the whole downstream cache, and Bedrock's server-side tool search is InvokeModel-only while Comparative uses Converse — the fix had to be app-layer without churning the cache (`spec:18-28`).

## Decision
The unit of dynamism is **which stable bundle a conversation runs on, never which tools a turn mounts** (`packages/agent/src/tool-bundles.ts:1-14`). Conversations start on a small core bundle — the two discovery tools plus the lightest providers, `CORE_MCP_PROVIDERS = ["google", "salesforce"]` (`apps/web/lib/tool-discovery.ts:23`) — and providers activate **additively and stickily**, persisted per-thread in `chat_threads.mcp_signature` so each bundle pays at most one cache write per conversation (`apps/web/lib/thread-activation.ts:22-38`, `tool-bundles.ts:73-75`). Activation happens three ways: the model calls `comparative__search_tools` then `comparative__activate_tools` (`packages/agent/src/discovery-tools.ts:19-20,95-139`), a provider proper-noun in the message pre-activates via a high-precision fast path (`tool-discovery.ts:35-55`), or an active skill declares its own bundle (`tool-discovery.ts:123-124`). The default flipped from `off` → `on` after the #384 P4 measurement on 2026-07-18 (`apps/web/lib/chat-routing.ts:387-400`).

## Consequences
- **Buys:** greetings and non-GitHub turns mount ~20 tools instead of 72 (measured cold greeting cache-write −66%, warm TTFT −15%; `chat-routing.ts:395-397`); the tools cache stays warm within a conversation because sticky-additive activation makes bundle flapping impossible by construction (`tool-bundles.ts:17-24`).
- **Costs:** the first non-core request in a conversation eats a discovery round-trip unless the fast-path noun hits (`tool-discovery.ts:125-135`); GitHub, once activated, is ~64 tools — back at the knee, only while GitHub work is live (`spec:84,138-140`).
- **Risk surface — honesty:** capability is now split into *mounted* vs *discoverable*, so the preamble/receipt must distinguish them and never deny a discoverable capability or claim an unmounted tool ran. `discoverableProviders` is derived from grants ∩ enabled catalog rows so the preamble can't point the model at a provider `activate_tools` would refuse (`tool-discovery.ts:57-69,146-150`; `discovery-tools.ts:115-121`).
- **Forecloses:** no mid-conversation deactivation — stickiness is the cache guarantee, so an over-broad bundle stays mounted until a new conversation (`tool-bundles.ts:20-24`). Catalog descriptions are rendered to the model nonce-framed as data, not instructions (`discovery-tools.ts:87-88`).
- **Debt:** `TOOL_DISCOVERY` env var and the `parity` mode remain as an escape hatch, slated for deletion after one stable release (`chat-routing.ts:383,398-399`).
