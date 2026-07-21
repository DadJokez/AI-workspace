import { describe, expect, it } from "vitest";
import { formatMessageTimestamp } from "@/lib/message-time";

const options = { locale: "en-US", timeZone: "UTC" };
const now = Date.parse("2026-07-21T18:00:00.000Z");

describe("formatMessageTimestamp", () => {
  it("formats recent messages relatively", () => {
    expect(
      formatMessageTimestamp("2026-07-21T17:58:00.000Z", now, options),
    ).toEqual({
      label: "2 min ago",
      iso: "2026-07-21T17:58:00.000Z",
    });
    expect(
      formatMessageTimestamp("2026-07-21T17:59:45.000Z", now, options)?.label,
    ).toBe("Just now");
  });

  it("uses local clock time for older messages from today", () => {
    expect(
      formatMessageTimestamp("2026-07-21T14:41:00.000Z", now, options)?.label,
    ).toBe("2:41 PM");
  });

  it("uses a compact date and adds the year only when needed", () => {
    expect(
      formatMessageTimestamp("2026-06-12T14:41:00.000Z", now, options)?.label,
    ).toBe("Jun 12");
    expect(
      formatMessageTimestamp("2025-12-31T14:41:00.000Z", now, options)?.label,
    ).toBe("Dec 31, 2025");
  });

  it("rejects missing and invalid timestamps", () => {
    expect(formatMessageTimestamp(undefined, now, options)).toBeNull();
    expect(formatMessageTimestamp("not-a-date", now, options)).toBeNull();
  });
});
