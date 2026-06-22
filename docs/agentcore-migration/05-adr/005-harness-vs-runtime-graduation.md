# ADR 005 — Harness-first, with a defined graduation path to Strands-on-Runtime

- **Status:** Proposed
- **Date:** 2026-06-19
- **Deciders:** Rob
- **Context docs:** [02 §10](../02-target-architecture.md), [03 Phase F](../03-roadmap.md)
- **Extends:** [ADR-001](001-adopt-agentcore-harness.md)

## Context

Managed Harness covers the agent-loop pattern but, per the GA docs, **cannot** do: custom frameworks,
bidirectional streaming, non-loop (graph/workflow) patterns, or hooks. Comparative has workloads that
will hit these limits — notably **app-build (J4)** and **agent-authored Databricks notebooks**, which
[ROADMAP.md:221](../../ROADMAP.md) already flags as architecturally novel. AWS provides
`agentcore export harness` → Strands code on Runtime, described as "a config-to-code translation, not
an architecture switch."

## Decision

**Harness-first for every use case**; **graduate to Strands-on-Runtime only when a use case provably
hits a Harness limit.** Keep the `AgentRuntime` seam ([factory.ts](../../../packages/agent-runtime/src/factory.ts))
so a lane can target a harness *or* exported Strands code by config, and keep `apps/agentcore-agent`
alive as the **landing zone** for exported code (it already speaks the Runtime contract —
[server.ts](../../../apps/agentcore-agent/src/server.ts)).

## Graduation triggers (decide per use case)

| Trigger | Example | Action |
|---|---|---|
| Non-loop / multi-stage deterministic flow | app-build pipeline, multi-step SAP txn | export → Strands graph |
| Hooks needed (logic mid-loop) | governance inside the loop | prefer keeping governance in shell pre/post; else export |
| Bidirectional streaming | future voice / interactive tool UI | Runtime |
| Workload, not a chat | agent-authored notebooks | likely Strands-on-Runtime from day one |

## Options

1. **Harness-only, accept the ceiling.** Rejected: blocks J4/notebooks.
2. **Runtime/Strands-only.** Rejected: we'd own the loop for the 90% of cases that don't need it.
3. **Harness-first + defined graduation (chosen).** Best of both; the seam + landing zone make
   graduation a config→code step.

## Consequences

**Positive:** simplest path for most use cases; no premature complexity; graduation is bounded and
reversible; we already have the Runtime container to receive exports.

**Negative / risks:** two runtime shapes to operate during/after graduation; need discipline to not
fork governance across shell-vs-Strands; Claude Agent SDK export ("coming soon") may later be the
preferred target over Strands ([04 E7](../04-open-questions.md)) — revisit when it GAs.
