import { describe, expect, it } from "vitest";
import { formatTurnMeter } from "@/lib/turn-cost";

describe("formatTurnMeter (#330)", () => {
  it("returns null with no usage", () => {
    expect(formatTurnMeter("sonnet-4-6", 0, 0)).toBeNull();
    expect(formatTurnMeter("sonnet-4-6", null, undefined)).toBeNull();
  });

  it("formats tokens and cost at standard registry rates", () => {
    // 21,533 in + 10 out on sonnet-4-6 (3.30/16.50 per MTok) ≈ $0.0712
    expect(formatTurnMeter("sonnet-4-6", 21_533, 10)).toBe(
      "21.5k tokens · \u2264$0.07",
    );
  });

  it("floors sub-cent turns instead of showing $0.00", () => {
    expect(formatTurnMeter("haiku-4-5", 300, 50)).toBe("350 tokens · <$0.01");
  });

  it("omits cost for unknown model ids but keeps tokens", () => {
    expect(formatTurnMeter("gpt-troll", 1_500, 500)).toBe("2k tokens");
    expect(formatTurnMeter(null, 1_500, 500)).toBe("2k tokens");
  });

  it("uses M for millions", () => {
    expect(formatTurnMeter(null, 2_400_000, 0)).toBe("2.4M tokens");
  });

  it("never renders 1000k at the M boundary", () => {
    expect(formatTurnMeter(null, 999_600, 0)).toBe("1M tokens");
  });
});
