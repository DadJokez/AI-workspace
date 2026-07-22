import { describe, expect, it } from "vitest";
import {
  normalizeFeedbackStatus,
  parseFeedbackStatusFilter,
  summarizeFeedbackStatusCounts,
} from "@/lib/feedback-status";

describe("feedback status helpers", () => {
  it("accepts known filters and defaults unknown input to new", () => {
    expect(parseFeedbackStatusFilter("all")).toBe("all");
    expect(parseFeedbackStatusFilter(["fixed", "new"])).toBe("fixed");
    expect(parseFeedbackStatusFilter("resolved")).toBe("new");
    expect(parseFeedbackStatusFilter(undefined)).toBe("new");
  });

  it("normalizes the legacy resolved status to fixed", () => {
    expect(normalizeFeedbackStatus("resolved")).toBe("fixed");
    expect(normalizeFeedbackStatus("triaged")).toBe("triaged");
  });

  it("folds legacy resolved counts into fixed without changing the total", () => {
    const { countByStatus, total } = summarizeFeedbackStatusCounts([
      { status: "triaged", count: 31 },
      { status: "fixed", count: 4 },
      { status: "resolved", count: 1 },
    ]);

    expect(total).toBe(36);
    expect(countByStatus.get("triaged")).toBe(31);
    expect(countByStatus.get("fixed")).toBe(5);
    expect(countByStatus.has("resolved")).toBe(false);
  });
});
