import { estimateUsageCostUsd, type ModelId } from "./models";
import type { TokenUsage } from "./types";

export const RUN_BUDGET_SCHEMA = "comparative.run-budget.v1" as const;
export const RUN_BUDGET_RECEIPT_SCHEMA =
  "comparative.run-budget-receipt.v1" as const;

export type RunBudgetGoverningLayer =
  | "organization"
  | "agent_skill"
  | "session";

export type RunBudgetDimension =
  | "tokens"
  | "usd"
  | "wall_clock"
  | "tool_iterations";

export interface RunBudgetLimits {
  tokens: number;
  usd: number;
  wallClockMs: number;
  toolIterations: number;
}

export interface RunBudgetConsumption {
  tokens: number;
  usd: number;
  wallClockMs: number;
  toolIterations: number;
}

export interface RunBudgetEnvelope {
  schema: typeof RUN_BUDGET_SCHEMA;
  version: 1;
  governingLayer: RunBudgetGoverningLayer;
  limits: RunBudgetLimits;
}

export interface RunBudgetState {
  envelope: RunBudgetEnvelope;
  consumed?: Partial<RunBudgetConsumption>;
}

export interface RunBudgetReceipt {
  schema: typeof RUN_BUDGET_RECEIPT_SCHEMA;
  version: 1;
  governingLayer: RunBudgetGoverningLayer;
  limits: RunBudgetLimits;
  consumed: RunBudgetConsumption;
  reached?: RunBudgetDimension;
  partial: boolean;
}

export class RunBudgetTracker {
  private readonly startedAtMs: number;
  private readonly prior: RunBudgetConsumption;
  private tokens = 0;
  private usd = 0;
  private toolIterations = 0;

  constructor(
    readonly state: RunBudgetState,
    private readonly modelId: ModelId,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAtMs = now();
    this.prior = normalizeConsumption(state.consumed);
  }

  recordUsage(usage: TokenUsage): void {
    this.tokens += usage.tokensIn + usage.tokensOut;
    this.usd += estimateUsageCostUsd(this.modelId, usage);
  }

  recordToolIteration(): void {
    this.toolIterations += 1;
  }

  remainingToolIterations(): number {
    return Math.max(
      0,
      this.state.envelope.limits.toolIterations -
        this.prior.toolIterations -
        this.toolIterations,
    );
  }

  reached(): RunBudgetDimension | undefined {
    return this.reachedFor(this.consumed());
  }

  private reachedFor(
    consumed: RunBudgetConsumption,
  ): RunBudgetDimension | undefined {
    const { limits } = this.state.envelope;
    if (consumed.tokens >= limits.tokens) return "tokens";
    if (atOrAbove(consumed.usd, limits.usd)) return "usd";
    if (consumed.wallClockMs >= limits.wallClockMs) return "wall_clock";
    if (consumed.toolIterations >= limits.toolIterations) {
      return "tool_iterations";
    }
    return undefined;
  }

  blockingProviderInvocation():
    | Exclude<RunBudgetDimension, "tool_iterations">
    | undefined {
    const reached = this.reached();
    return reached === "tool_iterations" ? undefined : reached;
  }

  receipt(partial: boolean): RunBudgetReceipt {
    const consumed = this.consumed();
    const reached = this.reachedFor(consumed);
    return {
      schema: RUN_BUDGET_RECEIPT_SCHEMA,
      version: 1,
      governingLayer: this.state.envelope.governingLayer,
      limits: { ...this.state.envelope.limits },
      consumed,
      ...(reached ? { reached } : {}),
      partial,
    };
  }

  private consumed(): RunBudgetConsumption {
    return {
      tokens: this.prior.tokens + this.tokens,
      usd: this.prior.usd + this.usd,
      wallClockMs:
        this.prior.wallClockMs + Math.max(0, this.now() - this.startedAtMs),
      toolIterations: this.prior.toolIterations + this.toolIterations,
    };
  }
}

export function parseRunBudgetState(value: unknown): RunBudgetState | undefined {
  if (!isRecord(value) || !isRecord(value.envelope)) return undefined;
  const envelope = value.envelope;
  if (
    envelope.schema !== RUN_BUDGET_SCHEMA ||
    envelope.version !== 1 ||
    !isGoverningLayer(envelope.governingLayer) ||
    !isRecord(envelope.limits)
  ) {
    return undefined;
  }
  const limits = parseLimits(envelope.limits);
  if (!limits) return undefined;
  const consumed = parseConsumption(value.consumed);
  if (value.consumed !== undefined && !consumed) return undefined;
  return {
    envelope: {
      schema: RUN_BUDGET_SCHEMA,
      version: 1,
      governingLayer: envelope.governingLayer,
      limits,
    },
    ...(consumed ? { consumed } : {}),
  };
}

export function parseRunBudgetReceipt(
  value: unknown,
): RunBudgetReceipt | undefined {
  if (
    !isRecord(value) ||
    value.schema !== RUN_BUDGET_RECEIPT_SCHEMA ||
    value.version !== 1 ||
    !isGoverningLayer(value.governingLayer) ||
    !isRecord(value.limits) ||
    !isRecord(value.consumed) ||
    typeof value.partial !== "boolean" ||
    (value.reached !== undefined && !isBudgetDimension(value.reached))
  ) {
    return undefined;
  }
  const limits = parseLimits(value.limits);
  const consumed = parseConsumption(value.consumed);
  if (!limits || !consumed) return undefined;
  return {
    schema: RUN_BUDGET_RECEIPT_SCHEMA,
    version: 1,
    governingLayer: value.governingLayer,
    limits,
    consumed,
    ...(value.reached ? { reached: value.reached } : {}),
    partial: value.partial,
  };
}

function parseLimits(value: Record<string, unknown>): RunBudgetLimits | null {
  const tokens = positiveInteger(value.tokens);
  const usd = positiveNumber(value.usd);
  const wallClockMs = positiveInteger(value.wallClockMs);
  const toolIterations = nonNegativeInteger(value.toolIterations);
  if (
    tokens === null ||
    usd === null ||
    wallClockMs === null ||
    toolIterations === null
  ) {
    return null;
  }
  return { tokens, usd, wallClockMs, toolIterations };
}

function parseConsumption(value: unknown): RunBudgetConsumption | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return null;
  const tokens = nonNegativeInteger(value.tokens ?? 0);
  const usd = nonNegativeNumber(value.usd ?? 0);
  const wallClockMs = nonNegativeNumber(value.wallClockMs ?? 0);
  const toolIterations = nonNegativeInteger(value.toolIterations ?? 0);
  if (
    tokens === null ||
    usd === null ||
    wallClockMs === null ||
    toolIterations === null
  ) {
    return null;
  }
  return { tokens, usd, wallClockMs, toolIterations };
}

function normalizeConsumption(
  value: Partial<RunBudgetConsumption> | undefined,
): RunBudgetConsumption {
  return {
    tokens: value?.tokens ?? 0,
    usd: value?.usd ?? 0,
    wallClockMs: value?.wallClockMs ?? 0,
    toolIterations: value?.toolIterations ?? 0,
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function atOrAbove(value: number, limit: number): boolean {
  const tolerance =
    Number.EPSILON *
    Math.max(Number.MIN_VALUE, Math.abs(value), Math.abs(limit)) *
    8;
  return value > limit || Math.abs(value - limit) <= tolerance;
}

function isGoverningLayer(value: unknown): value is RunBudgetGoverningLayer {
  return (
    value === "organization" ||
    value === "agent_skill" ||
    value === "session"
  );
}

function isBudgetDimension(value: unknown): value is RunBudgetDimension {
  return (
    value === "tokens" ||
    value === "usd" ||
    value === "wall_clock" ||
    value === "tool_iterations"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
