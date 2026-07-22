# ADR 0009: Progressive tool discovery via stable bundles + sticky activation

- **Status:** Accepted
- **Date:** 2026-07-19
- **Last updated:** 2026-07-22
- **Deciders:** Rob (owner), Claude/Codex (implementation)

## Context
Model-decided routing mounted the user's full tool catalog on every turn — 72
tools in production, of which GitHub alone was 44 schemas and ~73% of ~59.8K
schema chars. A 3-character greeting therefore paid a ~21.5K-token cache write
and sat past the ~30–50-tool knee where selection precision degrades
(`docs/PROGRESSIVE_TOOL_DISCOVERY_SPEC.md`). Bedrock's cache hierarchy is tools
→ system → messages, so any change to the mounted tool set invalidates the
whole downstream cache. Bedrock's server-side tool search is InvokeModel-only
while Comparative uses Converse, so the fix had to be app-layer without
churning the cache.

## Decision
The unit of dynamism is **which stable bundle a conversation runs on, never
which tools a turn mounts** (`packages/agent/src/tool-bundles.ts:1-14`).
Conversations start on a small core bundle — the two discovery tools plus the
lightest providers, `CORE_MCP_PROVIDERS = ["google", "salesforce"]`
(`apps/web/lib/tool-discovery.ts:22`) — and providers activate **additively and
stickily**, persisted per-thread in `chat_threads.mcp_signature` so each bundle
pays at most one cache write per conversation
(`apps/web/lib/thread-activation.ts:13-38`,
`packages/agent/src/tool-bundles.ts:68-75`). Activation happens three ways:
the model calls `comparative__search_tools` then
`comparative__activate_tools` (`packages/agent/src/discovery-tools.ts:19-20`,
`packages/agent/src/discovery-tools.ts:95-139`), a provider proper noun in the
message pre-activates via a high-precision fast path
(`apps/web/lib/tool-discovery.ts:24-54`), or an active Skill declares its own
bundle (`apps/web/lib/tool-discovery.ts:75-115`). #419 enabled the path after
the #384 P4 measurement on 2026-07-18; #499 removed the legacy `off` and
`parity` branches after the production soak, so progressive discovery is now
unconditional.

## Consequences
- **Buys:** greetings and non-GitHub turns mount ~20 tools instead of 72
  (measured cold greeting cache-write −66%, warm TTFT −15%;
  `docs/research/TOOL_DISCOVERY_BENCHMARK_2026-07-18.md`). The tools cache stays
  warm within a conversation because sticky-additive activation makes bundle
  flapping impossible by construction
  (`packages/agent/src/tool-bundles.ts:17-24`).
- **Costs:** the first non-core request in a conversation uses a discovery
  round-trip unless the provider-name fast path hits
  (`apps/web/lib/tool-discovery.ts:24-54`). GitHub, once activated, is ~64
  tools — back at the knee, but only while GitHub work is live.
- **Risk surface — honesty:** capability is split into *mounted* vs
  *discoverable*, so the preamble/receipt must distinguish them and never deny
  a discoverable capability or claim an unmounted tool ran.
  `discoverableProviders` is derived from grants ∩ enabled catalog rows so the
  preamble cannot point the model at a provider `activate_tools` would refuse
  (`apps/web/lib/tool-discovery.ts:56-69`,
  `apps/web/lib/tool-discovery.ts:119-129`,
  `packages/agent/src/discovery-tools.ts:115-121`).
- **Forecloses:** no mid-conversation deactivation — stickiness is the cache
  guarantee, so an over-broad bundle stays mounted until a new conversation
  (`packages/agent/src/tool-bundles.ts:17-24`). Catalog descriptions are
  rendered to the model nonce-framed as data, not instructions
  (`packages/agent/src/discovery-tools.ts:87-88`).
- **Rollback:** the rollout flag was removed in #499 after the stable-release
  soak. Rollback now uses a normal code revert rather than an environment
  switch.
