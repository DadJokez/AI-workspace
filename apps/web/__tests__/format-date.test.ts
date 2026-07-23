import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatMonthDay,
} from "@/lib/format-date";

describe("date formatting", () => {
  const localDate = new Date(2026, 0, 2, 15, 5);

  it("uses one explicit product locale for dates", () => {
    expect(formatDate(localDate)).toBe("Jan 2, 2026");
    expect(formatMonthDay(localDate)).toBe("Jan 2");
  });

  it("uses the shared date-time shape", () => {
    expect(formatDateTime(localDate)).toBe("Jan 2, 2026, 3:05 PM");
  });

  it("fails closed for invalid input", () => {
    expect(formatDate("not-a-date")).toBe("");
    expect(formatDateTime("not-a-date")).toBe("");
  });
});
