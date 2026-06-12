import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  isValidCadence,
  parseCadence,
} from "@/lib/schedules/next-run";

/**
 * Table-driven cadence tests (specs/002-skills-spine T300/T305), including
 * the 2026 America/New_York DST boundaries: spring forward on Mar 8 (EST
 * UTC-5 → EDT UTC-4) and fall back on Nov 1 (EDT → EST).
 */

const NY = "America/New_York";

function iso(value: string): Date {
  return new Date(value);
}

describe("parseCadence", () => {
  it("accepts the supported grammar", () => {
    expect(parseCadence("0 8 * * *")).toEqual({
      minute: 0,
      hour: 8,
      dayOfMonth: null,
      daysOfWeek: null,
    });
    expect(parseCadence("30 17 * * MON")).toEqual({
      minute: 30,
      hour: 17,
      dayOfMonth: null,
      daysOfWeek: [1],
    });
    expect(parseCadence("0 9 * * MON-FRI").daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCadence("0 7 15 * *").dayOfMonth).toBe(15);
  });

  it("rejects unsupported shapes", () => {
    expect(isValidCadence("0 8 * *")).toBe(false); // 4 fields
    expect(isValidCadence("60 8 * * *")).toBe(false); // minute out of range
    expect(isValidCadence("0 8 31 * *")).toBe(false); // dom > 28
    expect(isValidCadence("0 8 1 * MON")).toBe(false); // dom + dow
    expect(isValidCadence("0 8 * 6 *")).toBe(false); // month restriction
    expect(isValidCadence("0 8 * * FUNDAY")).toBe(false);
  });
});

describe("computeNextRunAt", () => {
  it("computes a plain daily occurrence in-zone", () => {
    // 2026-06-10 12:00 UTC = 08:00 EDT; next 08:00 ET is June 11.
    const next = computeNextRunAt("0 8 * * *", NY, iso("2026-06-10T12:00:00Z"));
    expect(next.toISOString()).toBe("2026-06-11T12:00:00.000Z");
  });

  it("is strictly after `after`, never equal", () => {
    const at = iso("2026-06-11T12:00:00Z"); // exactly 08:00 EDT
    const next = computeNextRunAt("0 8 * * *", NY, at);
    expect(next.toISOString()).toBe("2026-06-12T12:00:00.000Z");
  });

  it("keeps 8am local across the spring-forward transition", () => {
    // Sat 2026-03-07 08:00 EST = 13:00 UTC. Next day DST starts:
    // Sun 2026-03-08 08:00 EDT = 12:00 UTC — wall-clock stays 8am.
    const next = computeNextRunAt(
      "0 8 * * *",
      NY,
      iso("2026-03-07T13:00:01Z"),
    );
    expect(next.toISOString()).toBe("2026-03-08T12:00:00.000Z");
  });

  it("keeps 8am local across the fall-back transition", () => {
    // Sat 2026-10-31 08:00 EDT = 12:00 UTC. Sun 2026-11-01 fall back:
    // 08:00 EST = 13:00 UTC.
    const next = computeNextRunAt(
      "0 8 * * *",
      NY,
      iso("2026-10-31T12:00:01Z"),
    );
    expect(next.toISOString()).toBe("2026-11-01T13:00:00.000Z");
  });

  it("resolves a nonexistent spring-forward time to the shifted instant", () => {
    // 02:30 does not exist on 2026-03-08 in New York; clocks jump
    // 02:00 EST → 03:00 EDT, so the occurrence lands at 03:30 EDT
    // (07:30 UTC).
    const next = computeNextRunAt(
      "30 2 * * *",
      NY,
      iso("2026-03-08T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("finds the next weekly occurrence", () => {
    // 2026-06-11 is a Thursday; next Monday is 2026-06-15. 08:00 EDT = 12:00 UTC.
    const next = computeNextRunAt(
      "0 8 * * MON",
      NY,
      iso("2026-06-11T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-06-15T12:00:00.000Z");
  });

  it("skips weekends for weekday cadences", () => {
    // Friday 2026-06-12 18:00 ET is past 09:00; next weekday 09:00 is
    // Monday 2026-06-15. 09:00 EDT = 13:00 UTC.
    const next = computeNextRunAt(
      "0 9 * * MON-FRI",
      NY,
      iso("2026-06-12T22:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-06-15T13:00:00.000Z");
  });

  it("handles monthly day-of-month across month ends", () => {
    // After Jan 15 2026 07:00 ET, next 15th is Feb 15. 07:00 EST = 12:00 UTC.
    const next = computeNextRunAt(
      "0 7 15 * *",
      NY,
      iso("2026-01-15T12:00:01Z"),
    );
    expect(next.toISOString()).toBe("2026-02-15T12:00:00.000Z");
  });

  it("works in UTC and in zones east of UTC", () => {
    expect(
      computeNextRunAt("0 8 * * *", "UTC", iso("2026-06-10T09:00:00Z")).toISOString(),
    ).toBe("2026-06-11T08:00:00.000Z");
    // 08:00 in Tokyo (UTC+9, no DST) = 23:00 UTC the previous day.
    expect(
      computeNextRunAt(
        "0 8 * * *",
        "Asia/Tokyo",
        iso("2026-06-10T00:00:00Z"),
      ).toISOString(),
    ).toBe("2026-06-10T23:00:00.000Z");
  });

  it("rejects unknown timezones", () => {
    expect(() =>
      computeNextRunAt("0 8 * * *", "Mars/Olympus_Mons", new Date()),
    ).toThrow();
  });
});
