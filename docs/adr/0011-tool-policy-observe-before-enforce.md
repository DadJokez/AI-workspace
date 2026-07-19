# ADR 0011: Tri-state tool policy, observe before enforce

- **Status:** Accepted
- **Date:** 2026-07-19
- **Deciders:** Rob (owner), Claude/Codex (implementation)

## Context
Comparative already had an attestation gate that mounted MCP providers per-user, but no per-action runtime checkpoint before a tool executes — the "human-in-the-loop before destructive writes" gap named in the connector-governance spec (`docs/specs/connector-governance-architecture.md:99`, §4.2 recommendation at line 179). That spec also carries the load-bearing evidence that the gate must be deterministic, not a prompt instruction: a red-team measured a 26.67% policy-violation rate for prompt-only safety gating (`docs/specs/connector-governance-architecture.md:99`). The `tools_catalog` already records a read/write/admin action level per tool, so a policy could be derived from data that exists today with no migration.

## Decision
Tool authorization is a tri-state — `always_allow` / `needs_approval` / `blocked` — derived deterministically from the catalog action level in shell code, never from prompt text: `read → always_allow`, `write → needs_approval`, `admin → blocked`, with uncataloged tools failing toward caution (`needs_approval`) (`apps/web/lib/tool-policy.ts:22-43`). P1 ships in OBSERVE mode only: `observedPolicyDecision()` emits deliberately `would_*`-prefixed values (`apps/web/lib/tool-policy.ts:49-67`) that `buildToolAuditRows` stamps as `metadata.policyDecision` on every `mcp_tool_execution` audit row while enforcing nothing (`apps/web/lib/audit-tool-events.ts:167-179`). The decision input, `toolActions` keyed by `provider__toolName`, is built from the same catalog rows the attestation gate already loads (`apps/web/lib/tool-attestations.ts:37,57-58`).

## Consequences
- **Buys:** a deterministic authorization primitive independent of model behavior, plus an immediate audit record of what the policy *would* decide — so the eventual enforcement flip lands against measured production reality rather than guesses.
- **Buys:** zero migration and zero user-facing change now; the `would_*` naming makes it impossible to misread an observed row as an enforced one when the audit log is reviewed (asserted in `apps/web/__tests__/tool-policy.test.ts`).
- **Costs (deliberate debt):** the observe→enforce gap is real and open — nothing is actually blocked yet, so `admin` tools still run in P1. Closing it is scoped to #410 P2 (paused-run approval queue + blocked refusals; `apps/web/lib/tool-policy.ts:14-17`) and #436 presets.
- **Forecloses / defers:** P1 has no per-tool override column (policy is purely a function of action level) and no per-argument policy (e.g. spend limits); the spec explicitly defers an OPA/Cedar-style engine until per-argument requirements are real (`docs/specs/connector-governance-architecture.md:189`).
- **Uncataloged tools** with no catalog rows (e.g. builtin web tools) get no stamp at all rather than a guessed one (`apps/web/lib/audit-tool-events.ts:26-31,172`).

## Status notes
Enforcement is intentionally still open: the observe→enforce flip is tracked as #410 P2 (approval queue + blocked refusals) with policy presets in #436. This ADR documents only the P1 observe-mode primitive.
