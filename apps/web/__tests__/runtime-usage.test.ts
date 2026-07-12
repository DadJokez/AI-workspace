import { describe, expect, it } from "vitest";
import { normalizeRuntimeUsage } from "@/lib/runtime-usage";

describe("normalizeRuntimeUsage", () => {
  it("preserves cache-aware token billing classes", () => {
    expect(
      normalizeRuntimeUsage({
        tokensIn: 175,
        tokensOut: 25,
        inputTokens: 100,
        cacheReadInputTokens: 50,
        cacheWriteInputTokens: 25,
      }),
    ).toEqual({
      tokensIn: 175,
      tokensOut: 25,
      inputTokens: 100,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 25,
    });
  });

  it("treats legacy runtime input as uncached", () => {
    expect(normalizeRuntimeUsage({ tokensIn: 40, tokensOut: 5 })).toEqual({
      tokensIn: 40,
      tokensOut: 5,
      inputTokens: 40,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });
});
