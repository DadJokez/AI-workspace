/**
 * Presentation vocabulary for a run row (status dot + label, trigger label).
 * Client-safe: constants only. Shared by the skill detail page's run history
 * and the per-schedule history inside `SchedulePanel` (#780) so the two lists
 * cannot drift.
 */

export const RUN_STATUS_PRESENTATION: Record<
  string,
  { label: string; dotClass: string }
> = {
  queued: { label: "Queued", dotClass: "bg-muted" },
  running: { label: "Running", dotClass: "bg-info" },
  waiting_for_approval: { label: "Waiting for approval", dotClass: "bg-warning" },
  succeeded: { label: "Succeeded", dotClass: "bg-success" },
  failed: { label: "Failed", dotClass: "bg-danger" },
  canceled: { label: "Canceled", dotClass: "bg-muted" },
};

/** A run in one of these states is still in flight for its schedule. */
export const IN_FLIGHT_RUN_STATUSES = ["queued", "running"] as const;

export function isInFlightRunStatus(status: string): boolean {
  return (IN_FLIGHT_RUN_STATUSES as readonly string[]).includes(status);
}

export function runStatusPresentation(status: string) {
  return (
    RUN_STATUS_PRESENTATION[status] ?? {
      label: "Unknown",
      dotClass: "bg-muted",
    }
  );
}

/**
 * How a scheduled run was fired: on its cadence, or off-cycle from the
 * schedule's "Run now" action. Persisted in `runs.inputs.scheduleFire` (no
 * column — the marker rides the existing jsonb) so a manual fire is otherwise
 * indistinguishable from a cadence fire.
 */
export type ScheduleFire = "cadence" | "manual";

export function runTriggerLabel(
  triggerType: string,
  scheduleFire?: ScheduleFire | null,
): string {
  if (triggerType === "scheduled") {
    return scheduleFire === "manual" ? "Scheduled run · run now" : "Scheduled run";
  }
  const labels: Record<string, string> = {
    skill: "Manual run",
    github_event: "GitHub event",
  };
  return labels[triggerType] ?? "Skill run";
}

export function scheduleFireFromInputs(inputs: unknown): ScheduleFire | null {
  if (typeof inputs !== "object" || inputs === null) return null;
  const value = (inputs as Record<string, unknown>).scheduleFire;
  return value === "manual" || value === "cadence" ? value : null;
}
