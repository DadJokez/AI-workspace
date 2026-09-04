# ADR 0011: Tri-state tool policy, observe before enforce

- **Status:** Accepted — amended 2026-09-03: observe phase closed by #831–#835, universal fail-closed default by #701 (see Enforcement status)
- **Date:** 2026-07-19
- **Deciders:** Rob (owner), Claude/Codex (implementation)

## Context
Comparative already had an attestation gate that mounted MCP providers per-user, but no per-action runtime checkpoint before a tool executes — the "human-in-the-loop before destructive writes" gap named in the connector-governance spec (`docs/specs/connector-governance-architecture.md:99`, §4.2 recommendation at line 179). That spec also carries the load-bearing evidence that the gate must be deterministic, not a prompt instruction: a red-team measured a 26.67% policy-violation rate for prompt-only safety gating (`docs/specs/connector-governance-architecture.md:99`). The `tools_catalog` already records a read/write/admin action level per tool, so a policy could be derived from data that exists today with no migration.

## Decision
Tool authorization is a tri-state — `always_allow` / `needs_approval` / `blocked` — derived deterministically from the catalog action level in shell code, never from prompt text: `read → always_allow`, `write → needs_approval`, `admin → blocked`, with uncataloged tools failing toward caution (`needs_approval`) (`apps/web/lib/tool-policy.ts:31-43`). Since 2026-08-15 the same policy is persisted per tool in `tools_catalog.policy` (migration 0045, backfilled from action level) and enforced in the shared runtime loop; the `would_*`-prefixed stamp from `observedPolicyDecision()` (`apps/web/lib/tool-policy.ts:56-67`) survives only as the fallback `buildToolAuditRows` applies to rows that carry no executor decision (`apps/web/lib/audit-tool-events.ts:187-192`). The decision input, `toolActions` keyed by `provider__toolName`, is built from the same catalog rows the attestation gate already loads (`apps/web/lib/tool-attestations.ts:37,57-58`).

## Consequences
- **Buys:** a deterministic authorization primitive independent of model behavior, plus an immediate audit record of what the policy *would* decide — so the eventual enforcement flip lands against measured production reality rather than guesses.
- **Buys:** zero migration and zero user-facing change now; the `would_*` naming makes it impossible to misread an observed row as an enforced one when the audit log is reviewed (asserted in `apps/web/__tests__/tool-policy.test.ts`).
- **Costs (deliberate):** policy is still a pure function of action level plus the per-tool `policy` column — there is no per-argument policy (e.g. spend limits). Unattended runs (scheduled / GitHub-event) cannot pause for a human, so a `needs_approval` write in such a run is denied with a receipt rather than queued (`toolApprovalMode: "deny_unattended"`, `apps/web/lib/execute-chat-turn.ts:1149`); that fail-closed choice was made deliberately in #834.
- **Forecloses / defers:** P1 has no per-tool override column (policy is purely a function of action level) and no per-argument policy (e.g. spend limits); the spec explicitly defers an OPA/Cedar-style engine until per-argument requirements are real (`docs/specs/connector-governance-architecture.md:189`).
- **Uncataloged and builtin tools (since #701):** `Tool.policy` is a required field, so every builtin, MCP-mounted, and fixture tool decides at compile time — builtins declare `always_allow`; an MCP tool outside the catalog falls to `needs_approval` at the mount seam (`apps/web/lib/oauth/mcp-servers.ts:562`, `packages/agent/src/mcp.ts`); and a tool that still reaches the loop with no declared policy is treated as `needs_approval`, never executed silently (`packages/agent/src/loop.ts` `effectiveToolPolicy`). Every executed result is stamped with its actual decision; the `would_*` observe values survive only as the started-row/legacy fallback in `buildToolAuditRows` (`apps/web/lib/audit-tool-events.ts`).

## Enforcement status (2026-09-02, updated 2026-09-03)
The observe→enforce flip has landed; #410 (closed by #835) and #436 (closed by #837) are no longer pending.
- **#831** — persisted per-tool `tools_catalog.policy` (`tool_policy` enum), backfilled from action level; the `tool_policy_audit_decision` enum keeps the `would_*` values only as a fallback (`packages/db/drizzle/0045_tool_policy_persistence.sql:1-20`, `apps/web/lib/tool-policy.ts:1-20,31-43`).
- **#832** — `blocked` tools are refused in the shared loop before any handler runs, with the stable error code `tool_policy_blocked` (`packages/agent/src/loop.ts:100,575-590`).
- **#833** — `needs_approval` pauses the whole tool round; durable `tool_approval_requests`; `run_status` gains `waiting_for_approval`; the owner approves/denies in chat and the run resumes (`packages/agent/src/loop.ts:478,507-517`, migration 0046 `tool_approval_lifecycle`, `apps/web/lib/tool-approvals.ts`).
- **#834** — unattended runs fail closed (`toolApprovalMode: "deny_unattended"`, `apps/web/lib/execute-chat-turn.ts:1149`); 24 h approval expiry; 30-day standing Skill approvals (migration 0047 `standing_tool_approvals`).
- **#835** — org-disabled connectors fail closed at the mount gate; `/admin/connectors` (migration 0048 `connector_lifecycle_governance`).
- **#837** — autonomy presets (the #436 presets this ADR originally deferred to) bound to run context.
- **#701** (2026-09-03) — the gate is no longer opt-in per tool: an undeclared policy fails closed to `needs_approval` (attended: pause; unattended: deny with receipt), builtins declare their policy explicitly, and the eval harness runs `deny_unattended` so `scope-honesty-send-email` exercises the enforced path with no `knownIssue` marker.
- Audit rows carry the executor's *actual* decision; `would_*` is stamped only for legacy/in-flight rows (`apps/web/lib/audit-tool-events.ts:187-192`, `apps/web/lib/tool-policy.ts:44-67`).

### Residuals
- **#860** (open): the model's *prose* on a denied send sometimes opens with a send claim before self-correcting — an honesty-of-wording flake, not a boundary gap (the runtime denies the call 5/5).
- **#836** (open): Ping/SCIM deprovisioning → connector/attestation revocation.
- Send-shaped tools outside the catalog default to `needs_approval`, not `blocked`; whether they should be `blocked` is a product decision, not an enforcement gap.
- No per-argument policy engine (unchanged from "Forecloses / defers" above).
