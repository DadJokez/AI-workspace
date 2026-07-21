# ADR 001 — Adopt AgentCore Harness as the agent substrate

- **Status:** Proposed (pending B1, B3 in [04-open-questions.md](../04-open-questions.md))
- **Date:** 2026-06-19
- **Deciders:** Rob (owns merges), InfoSec (isolation review)
- **Context docs:** [01-current-state](../01-current-state.md), [02-target-architecture](../02-target-architecture.md), [03-roadmap](../03-roadmap.md)
- **Extends:** [docs/adr/0003-aws-only-runtime-substrate.md](../../adr/0003-aws-only-runtime-substrate.md)

## Context

Comparative runs two agent loops we maintain: an in-process Bedrock loop for chat
([packages/agent/src/loop.ts](../../../packages/agent/src/loop.ts)) and the same loop hosted in a
custom AgentCore **Runtime** container for durable lanes
([apps/agentcore-agent](../../../apps/agentcore-agent/src/server.ts)). We own the loop, tool dispatch,
truncation, sessions, streaming, retries, and we have **no tracing and no per-model cost metric**
([01 §8](../01-current-state.md)). On 2026-06-17 AWS GA'd the managed **AgentCore Harness**: the loop
becomes configuration (`CreateHarness`/`InvokeHarness`), with managed memory, identity, gateway,
observability, versioned endpoints, evals/optimization/A/B, and an export-to-Strands escape hatch.

## Decision

Adopt the managed Harness as the **target substrate** for the agent loop, reached through the existing
`AgentRuntime` seam ([factory.ts](../../../packages/agent-runtime/src/factory.ts)) via a new
`HarnessRuntime` adapter. Converge both existing loops onto it; keep Strands-on-Runtime (the current
container) as the **graduation landing zone** for workloads that outgrow config.

## Options considered

1. **Keep both hand-rolled loops.** Status quo. Rejected: ongoing loop maintenance, missing
   observability/cost-visibility, no managed memory/versioning, and we'd rebuild what GA now gives us.
2. **Standardize on custom-code AgentCore *Runtime* (no Harness).** We already have the container.
   Rejected as the *default*: we'd still own the loop. Retained only as the graduation path (ADR-005).
3. **Adopt managed Harness (chosen).** Loop → config; we keep the enterprise shell (auth, routing,
   context, governance, ledger). Best leverage of the existing seam.

## Consequences

**Positive:** stop maintaining the loop/sessions/scaling/truncation; gain tracing + per-model cost
metric; managed memory finally delivers the rolling summary we never shipped; instant endpoint rollback
replaces forced ECS replace; evals/A/B become first-class. Strengthens the enterprise story
(everything in AWS, microVM isolation per session).

**Negative / risks:** new ~4–5% AgentCore overhead ([cost-model.md](../specs/cost-model.md)); must map
our honesty/attestation/redaction governance around (not inside) the managed loop; the Notion same-
origin relay and per-user MCP bearer model need rework; dependency on a 3-day-old GA service; InfoSec
must clear the isolation model.

**Neutral:** model inference cost is unchanged (same Bedrock tokens) — this migration is justified by
operability and capability, **not** infra savings.
