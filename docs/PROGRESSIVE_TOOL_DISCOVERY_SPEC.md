# Progressive Tool Discovery Spec

**Issue:** #384 · **Related:** #364 (model-decided routing), #385 (volatile
context receipts), #367 (benchmark harness), docs/MODEL_DECIDED_ROUTING_SPEC.md
**Status:** Proposed
**Owner:** Rob (approval) · Codex/Claude (implementation through the PR gate)

## Problem

Model-decided routing (#364) mounts the user's full tool catalog on every
standard chat turn. That decision was made against an estimated 28–38 tools;
production mounts **72** (Run Inspector, 2026-07-16), of which GitHub alone is
44 tools and 73% of ~59.8K schema characters. A 3-character greeting pays a
21.5K-token cache write. Beyond cost, 72 is past the ~30–50-tool range where
tool-selection precision measurably degrades — this is now a quality risk, not
just an efficiency one.

## The design constraint the issue statement glosses over

"Dynamically mount only the selected schemas for the next iteration" is, taken
literally, a cache-churn machine. Bedrock's cache hierarchy is
tools → system → messages: **any change to the mounted tool set invalidates
the entire downstream cache**, including the system prefix #385 just
stabilized. Arbitrary per-turn tool sets would trade schema tokens for
cache-write tokens and TTFT — the regression #364 measured its way out of.

Bedrock's server-side tool search is not an option: it is InvokeModel-only and
Comparative uses the Converse API. The solution must be app-layer.

## Decision: stable bundles, sticky activation

Tool configs come from a small set of **deterministic, byte-stable bundles**,
each a stable cache prefix in its own right. The unit of dynamism is *which
bundle a conversation runs on*, not *which tools a turn mounts* — and bundle
changes are sticky (they persist for the rest of the conversation), so each
activated bundle pays at most one cache write per conversation.

- **Core bundle (always mounted):** the discovery surface
  (`comparative__search_tools`, `comparative__activate_tools`), builtin web
  tools when configured, and the user's *lightest* high-frequency provider
  set. Target: ≤20 tools, ≤15K schema chars.
- **Provider expansions:** one stable bundle per provider (github: 44,
  notion: 14, salesforce: 4, google: 8). An activated conversation runs
  core + its activated expansions. Bundle composition is a pure function of
  (user grants, activated set) with deterministic ordering — same inputs,
  same bytes.
- **Activation is conversation state**, persisted on the thread (not
  inferred per message). Three activation paths:
  1. **Model-driven:** the model calls `comparative__search_tools` (returns
     catalog matches from `tools_catalog` + connection state, framed as
     data), then `comparative__activate_tools(provider)`. The loop swaps in
     the expanded bundle for the next iteration; the turn continues without
     re-prompting the user.
  2. **Deterministic fast-path:** an explicit provider *name* in the user
     message ("check my GitHub…") pre-activates that provider's bundle
     before the first model call. This matches proper nouns from the
     provider registry only — it is capability *addressing*, not the intent
     *classification* #364 abolished; a miss costs one discovery round, never
     a wrong answer.
  3. **Skill-driven:** an activated Skill mounts exactly its declared tool
     set (its own stable bundle); the model may still discover approved
     additions via path 1.
- **Deactivation:** none mid-conversation (stickiness is the cache
  guarantee). New conversations start at core.

### Honesty invariants (the spine — non-negotiable)

- The preamble and context receipt must distinguish **mounted** from
  **available via discovery**. The assistant must never deny a capability
  that discovery could activate ("I can check GitHub — one moment") and
  never claim an unmounted tool already ran.
- `search_tools` results render nonce-framed as data, like every other
  untrusted catalog surface.
- All existing attestation, write-boundary, audit, redaction, and per-user
  credential checks apply unchanged at activation and call time. Discovery
  widens *visibility* of the user's own approved catalog, never *authority*.

## What this buys, concretely

| | Today | Core-only turn | Core+GitHub turn |
|---|---:|---:|---:|
| Tools mounted | 72 | ~20 | ~64 |
| Schema chars | ~59.8K | ~15K | ~55K |
| Selection-precision regime | above the knee | comfortably under | at the knee, only when GitHub work is live |

The dominant win is structural: greetings and non-GitHub work (the vast
majority of turns) stop paying for 44 GitHub schemas, and the tools cache
stays warm within every conversation because bundles never flap.

## Delivery plan (each phase one PR through the gate)

**P1 — Bundle substrate.** Pure bundle builder (grants + activated set →
deterministic tool config), thread-level activation state, loop support for
swapping tool config between iterations. Behind `TOOL_DISCOVERY=off|on`,
default off; `on` initially behaves identically (all providers pre-activated)
to prove byte-stability parity. Unit pins: bundle determinism, ordering
stability, parity-with-today under full activation.

**P2 — Discovery tools + core default.** `comparative__search_tools` /
`comparative__activate_tools` (first-party, nonce-framed results, audited),
core bundle default, preamble/receipt honesty updates. Behavioral evals
extend the #364 P3 suite: "check my PRs" from a cold conversation must
activate github and answer in one user-visible turn; "how are you?" must stay
core with no discovery call; capability questions must acknowledge
discoverable-but-unmounted providers.

**P3 — Fast-path + skill scoping.** Provider-name pre-activation; Skills
mount declared bundles. Evals: explicit mentions skip the discovery
round-trip (assert single provider iteration).

**P4 — Measure and flip.** Rerun the #367 benchmark shape (cold/warm × core
vs full) plus Run Inspector trace comparison; flip the default when TTFT,
cache-read ratio, and tool-selection evals all beat the full-catalog
baseline. Delete the flag after one stable release.

## Acceptance criteria

- A tool-less turn mounts ≤20 schemas and its tools cache reads warm on the
  next turn.
- Cold "check my GitHub PRs" answers correctly in one user-visible turn (fast
  path), and so does its paraphrase without the provider name (one discovery
  round, same turn).
- The assistant never denies a discoverable capability (honesty evals).
- Activated conversations never flap bundles; Run Inspector traces show at
  most one tools-cache write per activated bundle per conversation.
- Skills run with exactly their declared tools unless discovery explicitly
  adds an approved capability.

## Risks

- **Discovery round-trip latency** on the first non-core request in a
  conversation — bounded by the fast path and stickiness; measured in P4
  before any flip.
- **Bundle flapping** via repeated activations — impossible by construction
  (activation is additive and sticky).
- **Honesty regressions** — the receipt/preamble split is the risk surface;
  P2 lands the eval coverage before the default changes.
- **GitHub stays heavy** once activated (64 tools ≈ the knee). Follow-up
  lever if evals show precision loss: split the GitHub expansion into
  read/triage vs write sub-bundles. Explicitly out of scope for v1.
