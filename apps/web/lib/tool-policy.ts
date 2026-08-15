import type { ToolRuntimePolicy } from "@ai-workspace/agent";

/**
 * Tri-state runtime tool policy (#410 P1, from
 * docs/specs/connector-governance-architecture.md).
 *
 * The policy is deterministic shell code, never a prompt instruction (the
 * spec's evidence: prompt-only gating fails at a 26.67% violation rate).
 * The catalog persists the effective per-tool policy. Existing rows were
 * backfilled from their action level:
 *
 *   read  → always_allow   (with attestation, unchanged from today)
 *   write → needs_approval
 *   admin → blocked
 *
 * Blocked MCP tools are refused in the shared runtime loop. Until the durable
 * approval queue lands, needs_approval remains a "would_need_approval" audit
 * observation and keeps the existing provider-specific write controls. Tools
 * missing from the catalog also observe as needs_approval — fail toward
 * caution, never toward silence.
 */

export type ToolActionLevel = "read" | "write" | "admin";

export type ToolPolicyDecision = ToolRuntimePolicy;

/** Stable key shape shared by catalog policy maps across runtime lanes. */
export function toolActionKey(provider: string, toolName: string): string {
  return `${provider}__${toolName}`;
}

export function resolveToolPolicy(
  action: ToolActionLevel | undefined,
): ToolPolicyDecision {
  switch (action) {
    case "read":
      return "always_allow";
    case "admin":
      return "blocked";
    case "write":
    default:
      return "needs_approval";
  }
}

/**
 * Observe-mode audit stamp: "would_*" naming keeps observation impossible
 * to misread as enforcement when the audit log is reviewed.
 */
export type ObservedPolicyDecision =
  | "auto_allowed"
  | "would_need_approval"
  | "would_block"
  | "uncataloged_would_need_approval";

export function observedPolicyDecision(
  policy: ToolPolicyDecision | undefined,
): ObservedPolicyDecision {
  if (policy === undefined) return "uncataloged_would_need_approval";
  switch (policy) {
    case "always_allow":
      return "auto_allowed";
    case "blocked":
      return "would_block";
    case "needs_approval":
      return "would_need_approval";
  }
}
