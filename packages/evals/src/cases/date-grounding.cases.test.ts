import { describe, expect, it } from "vitest";
import { statesPlausibleDaysUntilNextYear } from "./date-grounding.cases";

function passed(result: ReturnType<typeof statesPlausibleDaysUntilNextYear>) {
  return typeof result === "boolean" ? result : result.ok;
}

describe("days-until-new-year grounding guard", () => {
  const august11 = new Date("2026-08-11T12:00:00Z");

  it.each([
    "The current date is August 11, 2026, so there are 143 days until January 1, 2027.",
    "Days remaining: 143 (target year 2027).",
    "About 144 calendar days remain until New Year 2027.",
  ])("accepts a date-grounded countdown without reading the day-of-month: %s", (answer) => {
    expect(passed(statesPlausibleDaysUntilNextYear(answer, august11))).toBe(true);
  });

  it.each([
    "The current date is August 11, 2026.",
    "There are 11 days until January 1, 2027.",
    "There are 300 days until January 1, 2027.",
  ])("fails closed when no plausible countdown is stated: %s", (answer) => {
    expect(passed(statesPlausibleDaysUntilNextYear(answer, august11))).toBe(false);
  });
});
