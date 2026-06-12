import { describe, expect, it } from "vitest";
import {
  buildDaySeries,
  parseUsageWindow,
  percent,
  windowDays,
  windowSince,
} from "@/lib/usage-analytics";

describe("usage-analytics", () => {
  it("parses the window, defaulting to 30d", () => {
    expect(parseUsageWindow("7d")).toBe("7d");
    expect(parseUsageWindow("90d")).toBe("90d");
    expect(parseUsageWindow(undefined)).toBe("30d");
    expect(parseUsageWindow("nonsense")).toBe("30d");
    expect(parseUsageWindow(["7d", "30d"])).toBe("7d");
  });

  it("derives an inclusive UTC window bound covering today plus prior days", () => {
    const now = new Date("2026-06-12T15:30:00Z");
    // 7d = today (the 12th) plus the six preceding days → since = the 6th at UTC midnight.
    expect(windowSince("7d", now).toISOString()).toBe("2026-06-06T00:00:00.000Z");
    expect(windowDays("30d")).toBe(30);
  });

  it("densifies sparse counts into one zero-filled entry per day, oldest first", () => {
    const now = new Date("2026-06-12T15:30:00Z");
    const series = buildDaySeries(
      [
        { day: "2026-06-12", count: 5 },
        { day: "2026-06-10", count: 2 },
      ],
      "7d",
      now,
    );
    expect(series).toHaveLength(7);
    expect(series[0]).toEqual({ day: "2026-06-06", count: 0 });
    expect(series[series.length - 1]).toEqual({ day: "2026-06-12", count: 5 });
    expect(series.find((d) => d.day === "2026-06-10")).toEqual({
      day: "2026-06-10",
      count: 2,
    });
    // Every day in between is present and zero-filled.
    expect(series.filter((d) => d.count === 0)).toHaveLength(5);
  });

  it("computes whole-number percentages and guards divide-by-zero", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(0, 0)).toBe(0);
    expect(percent(2, 3)).toBe(67);
  });
});
