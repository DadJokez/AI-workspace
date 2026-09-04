import {
  RUN_BUDGET_SCHEMA,
  parseRunBudgetReceipt,
  parseRunBudgetState,
  type RunBudgetDimension,
  type RunBudgetEnvelope,
  type RunBudgetLimits,
  type RunBudgetReceipt,
  type RunBudgetState,
} from "@ai-workspace/agent";

import type { ChatRuntimeLane } from "@/lib/chat-routing";

export type RunBudgetProfile =
  | ChatRuntimeLane
  | "skill"
  | "scheduled"
  | "event"
  | "retry"
  | "child";

const MINUTE_MS = 60_000;

/**
 * Immutable organization defaults for the first budget rollout. These are
 * intentionally generous: they stop runaway work without turning normal
 * agent use into a stream of approval prompts. Future admin-editable limits
 * belong to the separately gated persisted-policy work.
 */
export const RUN_BUDGET_DEFAULTS: Readonly<Record<RunBudgetProfile, RunBudgetLimits>> =
  Object.freeze({
    "fast-local": limits(120_000, 1, 5 * MINUTE_MS, 0),
    "tool-local": limits(400_000, 4, 15 * MINUTE_MS, 8),
    "durable-local": limits(1_000_000, 10, 60 * MINUTE_MS, 8),
    skill: limits(750_000, 8, 45 * MINUTE_MS, 8),
    scheduled: limits(750_000, 8, 45 * MINUTE_MS, 8),
    event: limits(750_000, 8, 45 * MINUTE_MS, 8),
    retry: limits(1_000_000, 10, 60 * MINUTE_MS, 8),
    child: limits(1_000_000, 10, 60 * MINUTE_MS, 8),
  });

export function resolveNewRunBudget({
  lane,
  triggerType,
}: {
  lane: ChatRuntimeLane;
  triggerType: string;
}): RunBudgetState {
  return { envelope: envelopeFor(profileForRun(lane, triggerType)) };
}

/** A retry keeps the source envelope but starts with fresh consumption. */
export function resolveRetryRunBudget({
  source,
  lane,
  triggerType,
}: {
  source: unknown;
  lane: ChatRuntimeLane;
  triggerType: string;
}): RunBudgetState {
  const parsed = parseRunBudgetState(source);
  return parsed
    ? { envelope: parsed.envelope }
    : { envelope: envelopeFor(profileForRun(lane, triggerType)) };
}

/**
 * Reconstruct execution state from server-persisted inputs and the latest
 * authoritative receipt. Approval resume reuses consumption; a new retry
 * does not because it has no prior receipt on its new run row.
 */
export function resolveStoredRunBudget({
  stored,
  priorReceipt,
  lane,
  triggerType,
}: {
  stored: unknown;
  priorReceipt?: unknown;
  lane: ChatRuntimeLane;
  triggerType: string;
}): RunBudgetState {
  const parsed =
    parseRunBudgetState(stored) ?? resolveNewRunBudget({ lane, triggerType });
  const receipt = parseRunBudgetReceipt(priorReceipt);
  if (!receipt || !receiptMatchesEnvelope(receipt, parsed.envelope)) {
    return { envelope: parsed.envelope };
  }
  return { envelope: parsed.envelope, consumed: receipt.consumed };
}

/**
 * The budget dimension that truncated a completed run, or null when the run
 * finished its work. `run_status` stays `succeeded` for a budget stop (#848):
 * `outputs.budgetReceipt` is the one row-level truncation signal, and every
 * consumer that presents run status as an outcome reads it through here.
 */
export function budgetTruncation(outputs: unknown): RunBudgetDimension | null {
  if (!isRecord(outputs)) return null;
  const receipt = parseRunBudgetReceipt(outputs.budgetReceipt);
  return receipt?.partial === true && receipt.reached !== undefined
    ? receipt.reached
    : null;
}

/** Human label for a budget dimension; `undefined` reads as "configured". */
export function budgetDimensionLabel(
  dimension: RunBudgetDimension | undefined,
): string {
  switch (dimension) {
    case "tokens":
      return "token";
    case "usd":
      return "cost";
    case "wall_clock":
      return "time";
    case "tool_iterations":
      return "tool-step";
    default:
      return "configured";
  }
}

export function runBudgetEnvelopeForEvent(
  state: RunBudgetState,
): RunBudgetEnvelope {
  return {
    ...state.envelope,
    limits: { ...state.envelope.limits },
  };
}

export function runBudgetLaneFromRoute(
  value: unknown,
  fallback: ChatRuntimeLane = "durable-local",
): ChatRuntimeLane {
  if (!isRecord(value)) return fallback;
  return value.lane === "fast-local" ||
    value.lane === "tool-local" ||
    value.lane === "durable-local"
    ? value.lane
    : fallback;
}

function profileForRun(
  lane: ChatRuntimeLane,
  triggerType: string,
): RunBudgetProfile {
  if (triggerType === "proposal_iteration" || triggerType === "artifact_review") {
    return "child";
  }
  if (triggerType === "scheduled") return "scheduled";
  if (triggerType === "github_event") return "event";
  if (triggerType === "chat_retry" || triggerType === "skill_retry") {
    return "retry";
  }
  if (triggerType === "skill") return "skill";
  return lane;
}

function envelopeFor(profile: RunBudgetProfile): RunBudgetEnvelope {
  return {
    schema: RUN_BUDGET_SCHEMA,
    version: 1,
    governingLayer: "organization",
    limits: { ...RUN_BUDGET_DEFAULTS[profile] },
  };
}

function receiptMatchesEnvelope(
  receipt: RunBudgetReceipt,
  envelope: RunBudgetEnvelope,
): boolean {
  return (
    receipt.governingLayer === envelope.governingLayer &&
    receipt.limits.tokens === envelope.limits.tokens &&
    receipt.limits.usd === envelope.limits.usd &&
    receipt.limits.wallClockMs === envelope.limits.wallClockMs &&
    receipt.limits.toolIterations === envelope.limits.toolIterations
  );
}

function limits(
  tokens: number,
  usd: number,
  wallClockMs: number,
  toolIterations: number,
): RunBudgetLimits {
  return Object.freeze({ tokens, usd, wallClockMs, toolIterations });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
