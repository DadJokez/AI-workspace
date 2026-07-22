import { describe, expect, it } from "vitest";
import { percentOf, scaleBarValues } from "@/lib/admin-chart";

describe("admin chart scaling", () => {
  it("keeps an all-zero series at zero", () => {
    expect(scaleBarValues([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("scales a single value to the chart maximum", () => {
    expect(scaleBarValues([42])).toEqual([100]);
  });

  it("preserves ratios across large ranges", () => {
    expect(scaleBarValues([1_000_000, 250_000, 0])).toEqual([100, 25, 0]);
  });

  it("computes safe row percentages", () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(5, 0)).toBe(0);
  });
});
