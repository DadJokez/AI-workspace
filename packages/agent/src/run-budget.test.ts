import { describe, expect, it } from "vitest";

import { estimateUsageCostUsd } from "./models";
import {
  RUN_BUDGET_SCHEMA,
  RunBudgetTracker,
  parseRunBudgetReceipt,
  parseRunBudgetState,
  type RunBudgetState,
} from "./run-budget";

const STATE: RunBudgetState = {
  envelope: {
    schema: RUN_BUDGET_SCHEMA,
    version: 1,
    governingLayer: "organization",
    limits: {
      tokens: 1_000,
      usd: 1,
      wallClockMs: 10_000,
      toolIterations: 4,
    },
  },
};

describe("run budget contract", () => {
  it("parses only the versioned trusted shape", () => {
    expect(
      parseRunBudgetState({
        ...STATE,
        promptOverride: "unlimited",
        envelope: {
          ...STATE.envelope,
          untrusted: "drop-me",
          limits: { ...STATE.envelope.limits, extra: 99 },
        },
      }),
    ).toEqual(STATE);
    expect(
      parseRunBudgetState({
        ...STATE,
        envelope: {
          ...STATE.envelope,
          limits: { ...STATE.envelope.limits, tokens: 0 },
        },
      }),
    ).toBeUndefined();
    expect(
      parseRunBudgetState({
        ...STATE,
        consumed: { tokens: 1.5 },
      }),
    ).toBeUndefined();
    expect(
      parseRunBudgetState({
        ...STATE,
        consumed: { toolIterations: 0.5 },
      }),
    ).toBeUndefined();
  });

  it("strictly parses terminal receipts for persistence and resume", () => {
    const receipt = new RunBudgetTracker(
      {
        ...STATE,
        consumed: { tokens: 20, usd: 0.01, wallClockMs: 50, toolIterations: 1 },
      },
      "sonnet-4-6",
      () => 1_000,
    ).receipt(false);

    expect(
      parseRunBudgetReceipt({ ...receipt, untrusted: "drop-me" }),
    ).toEqual(receipt);
    expect(
      parseRunBudgetReceipt({
        ...receipt,
        consumed: { ...receipt.consumed, tokens: 1.5 },
      }),
    ).toBeUndefined();
    expect(
      parseRunBudgetReceipt({ ...receipt, reached: "unlimited" }),
    ).toBeUndefined();
  });

  it("uses the cache billing classes for measured USD", () => {
    const cost = estimateUsageCostUsd("sonnet-4-6", {
      inputTokens: 100,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 50,
      tokensOut: 20,
    });
    expect(cost).toBeCloseTo(
      0.000_33 + 0.000_297 + 0.000_206_25 + 0.000_33,
      12,
    );
  });

  it("treats boundary equality as reached", () => {
    const tracker = new RunBudgetTracker(STATE, "sonnet-4-6", () => 1_000);
    tracker.recordUsage({
      tokensIn: 900,
      tokensOut: 100,
      inputTokens: 900,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(tracker.reached()).toBe("tokens");
    expect(tracker.receipt(true)).toMatchObject({
      reached: "tokens",
      partial: true,
      consumed: { tokens: 1_000 },
    });
  });

  it("enforces measured USD at boundary equality", () => {
    const tracker = new RunBudgetTracker(
      {
        envelope: {
          ...STATE.envelope,
          limits: { ...STATE.envelope.limits, usd: 0.000_006_6 },
        },
      },
      "sonnet-4-6",
      () => 1_000,
    );
    tracker.recordUsage({
      tokensIn: 2,
      tokensOut: 0,
      inputTokens: 2,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });

    expect(tracker.reached()).toBe("usd");
    const receipt = tracker.receipt(true);
    expect(receipt).toMatchObject({
      reached: "usd",
    });
    expect(receipt.consumed.usd).toBeCloseTo(0.000_006_6, 15);
  });

  it("prices legacy aggregate input usage as normal input", () => {
    const tracker = new RunBudgetTracker(STATE, "sonnet-4-6", () => 1_000);
    tracker.recordUsage({
      tokensIn: 100,
      tokensOut: 10,
      inputTokens: 100,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });

    expect(tracker.receipt(false).consumed.usd).toBeCloseTo(
      0.000_33 + 0.000_165,
      12,
    );
  });

  it("continues cumulative consumption without counting approval wait time", () => {
    let now = 5_000;
    const tracker = new RunBudgetTracker(
      {
        envelope: STATE.envelope,
        consumed: {
          tokens: 200,
          usd: 0.1,
          wallClockMs: 600,
          toolIterations: 2,
        },
      },
      "sonnet-4-6",
      () => now,
    );
    now += 250;
    expect(tracker.receipt(false).consumed).toMatchObject({
      tokens: 200,
      usd: 0.1,
      wallClockMs: 850,
      toolIterations: 2,
    });
    expect(tracker.remainingToolIterations()).toBe(2);
  });
});
