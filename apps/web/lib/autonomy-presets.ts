export const AUTONOMY_PRESETS = {
  interactive: {
    name: "interactive",
    label: "Interactive",
    description: "Reads run immediately. Writes pause for approval. Admin actions stay blocked.",
    read: "allow",
    write: "request_approval",
    admin: "block",
  },
  unattended: {
    name: "unattended",
    label: "Unattended",
    description: "Reads run immediately. Writes are skipped and reported. Admin actions stay blocked.",
    read: "allow",
    write: "deny_and_report",
    admin: "block",
  },
  restricted: {
    name: "restricted",
    label: "Restricted",
    description: "Read-only. Writes and admin actions are denied.",
    read: "allow",
    write: "deny",
    admin: "block",
  },
} as const;

export type AutonomyPresetName = keyof typeof AUTONOMY_PRESETS;
export type AutonomyPreset = (typeof AUTONOMY_PRESETS)[AutonomyPresetName];

const UNATTENDED_TRIGGER_TYPES = new Set(["scheduled", "github_event"]);

/**
 * Autonomy is bound to trusted run context, never a client-selected toggle.
 * Restricted is defined here as the future stricter cap; no current context
 * is bound to it, so today it cannot be used to loosen another preset.
 */
export function resolveAutonomyPreset(triggerType: string): AutonomyPreset {
  return UNATTENDED_TRIGGER_TYPES.has(triggerType)
    ? AUTONOMY_PRESETS.unattended
    : AUTONOMY_PRESETS.interactive;
}

export interface AutonomyReceipt {
  preset: AutonomyPresetName;
  skippedWriteCount: number;
  reason?: "denied_unattended";
}

export function buildAutonomyReceipt(
  preset: AutonomyPresetName,
  skippedWriteCount = 0,
): AutonomyReceipt {
  return {
    preset,
    skippedWriteCount,
    ...(skippedWriteCount > 0 ? { reason: "denied_unattended" as const } : {}),
  };
}

export function countUnattendedWriteDenials(
  results: readonly { output: unknown }[],
): number {
  return results.filter((result) =>
    hasErrorCode(result.output, "tool_approval_unattended_denied"),
  ).length;
}

function hasErrorCode(output: unknown, code: string): boolean {
  if (isRecord(output)) return output.error === code;
  if (typeof output !== "string") return false;
  try {
    const parsed = JSON.parse(output) as unknown;
    return isRecord(parsed) && parsed.error === code;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
