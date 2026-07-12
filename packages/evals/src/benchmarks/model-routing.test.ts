import { describe, expect, it } from "vitest";
import {
  FakeBedrockClient,
  type TokenUsage,
} from "@ai-workspace/agent";
import {
  ROUTING_BENCHMARK_MAX_CALLS,
  approximateStablePrefixTokens,
  buildRoutingBenchmarkPlan,
  estimateUsageCostUsd,
  median,
  runRoutingBenchmark,
} from "./model-routing";

describe("model routing benchmark", () => {
  it("keeps the paid matrix at the fixed call cap", () => {
    const plan = buildRoutingBenchmarkPlan();
    expect(plan).toHaveLength(ROUTING_BENCHMARK_MAX_CALLS);
    expect(plan.filter((item) => item.phase === "cold")).toHaveLength(9);
    expect(plan.filter((item) => item.phase === "warm")).toHaveLength(9);
  });

  it("uses a cache-eligible representative full prefix", () => {
    expect(approximateStablePrefixTokens(false)).toBeLessThan(4_096);
    expect(approximateStablePrefixTokens(true)).toBeGreaterThanOrEqual(4_096);
  });

  it("prices normal, cache-read, cache-write, and output tokens separately", () => {
    const usage: TokenUsage = {
      tokensIn: 6_000,
      tokensOut: 100,
      inputTokens: 500,
      cacheReadInputTokens: 4_000,
      cacheWriteInputTokens: 1_500,
    };
    expect(estimateUsageCostUsd("haiku-4-5", usage)).toBeCloseTo(
      (500 * 1.1 + 4_000 * 0.11 + 1_500 * 1.375 + 100 * 5.5) /
        1_000_000,
    );
  });

  it("computes medians for odd and even samples", () => {
    expect(median([])).toBeNull();
    expect(median([9, 1, 4])).toBe(4);
    expect(median([10, 2, 8, 4])).toBe(6);
  });

  it("can execute the complete matrix without AWS", async () => {
    const results = await runRoutingBenchmark(
      new FakeBedrockClient({ delayMs: 0 }),
    );
    expect(results).toHaveLength(ROUTING_BENCHMARK_MAX_CALLS);
    expect(results.every((result) => result.tokensIn > 0)).toBe(true);
    expect(results.every((result) => result.estimatedCostUsd > 0)).toBe(true);
  });
});
