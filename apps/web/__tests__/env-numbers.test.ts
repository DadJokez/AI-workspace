import { describe, expect, it } from "vitest";
import {
  nonNegativeNumber,
  positiveNumber,
} from "../scripts/env-numbers";

/**
 * #579 review follow-up: the smoke scripts' env parsing is pure logic and
 * the zero-vs-positive distinction is load-bearing — SMOKE_REQUEST_PACE_MS=0
 * must disable pacing, not fall back to the 500ms default.
 */
describe("nonNegativeNumber", () => {
  it("accepts an explicit 0 (pacing disabled) instead of falling back", () => {
    expect(nonNegativeNumber("0", 500)).toBe(0);
  });

  it("parses positive values and rejects garbage to the fallback", () => {
    expect(nonNegativeNumber("250", 500)).toBe(250);
    expect(nonNegativeNumber("-1", 500)).toBe(500);
    expect(nonNegativeNumber("abc", 500)).toBe(500);
    expect(nonNegativeNumber("", 500)).toBe(500);
    expect(nonNegativeNumber(undefined, 500)).toBe(500);
    expect(nonNegativeNumber("Infinity", 500)).toBe(500);
  });
});

describe("positiveNumber", () => {
  it("rejects 0 and negatives to the fallback (0 is not a valid timeout)", () => {
    expect(positiveNumber("0", 1000)).toBe(1000);
    expect(positiveNumber("-5", 1000)).toBe(1000);
    expect(positiveNumber("1500", 1000)).toBe(1500);
    expect(positiveNumber(undefined, 1000)).toBe(1000);
  });
});
