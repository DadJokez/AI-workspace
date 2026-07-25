import { describe, expect, it } from "vitest";
import {
  renderResolvedDateReferences,
  resolveRelativeDateReferences,
} from "./temporal";
import { normalizeUserTimeZone } from "./timezone";

const NY = "America/New_York";

function resolveOne(text: string, now: Date, timeZone = NY) {
  const refs = resolveRelativeDateReferences(text, now, timeZone);
  expect(refs).toHaveLength(1);
  return refs[0]!;
}

describe("resolveRelativeDateReferences", () => {
  // Thursday 2026-07-23, mid-afternoon in New York.
  const thursday = new Date("2026-07-23T18:00:00.000Z");

  it("resolves today, tonight, tomorrow, and yesterday to local dates", () => {
    expect(resolveOne("what's on today?", thursday)).toEqual({
      sourceText: "today",
      isoDate: "2026-07-23",
      weekday: "Thursday",
    });
    expect(resolveOne("free tonight?", thursday).isoDate).toBe("2026-07-23");
    expect(resolveOne("ship it tomorrow", thursday)).toEqual({
      sourceText: "tomorrow",
      isoDate: "2026-07-24",
      weekday: "Friday",
    });
    expect(resolveOne("what happened yesterday?", thursday).isoDate).toBe(
      "2026-07-22",
    );
  });

  it("resolves 'today' in the user's zone, not UTC's calendar day", () => {
    // 01:00Z on July 9 is still the evening of Wednesday, July 8 in New York,
    // but already Thursday, July 9 in Tokyo.
    const now = new Date("2026-07-09T01:00:00.000Z");
    expect(resolveOne("today", now, NY).isoDate).toBe("2026-07-08");
    expect(resolveOne("today", now, "Asia/Tokyo").isoDate).toBe("2026-07-09");
  });

  it("resolves a bare weekday to the nearest occurrence on or after today", () => {
    // Thursday → Monday is next week's Monday; Friday is tomorrow.
    expect(resolveOne("see you monday", thursday)).toEqual({
      sourceText: "monday",
      isoDate: "2026-07-27",
      weekday: "Monday",
    });
    expect(resolveOne("by Friday please", thursday).isoDate).toBe("2026-07-24");
  });

  it("resolves a bare weekday naming today to today", () => {
    // Tuesday 2026-07-28.
    const tuesday = new Date("2026-07-28T15:00:00.000Z");
    expect(resolveOne("is tuesday ok?", tuesday)).toEqual({
      sourceText: "tuesday",
      isoDate: "2026-07-28",
      weekday: "Tuesday",
    });
  });

  it("resolves 'this <weekday>' within the current ISO week, even when past", () => {
    // Saturday 2026-07-25: "this monday" is the Monday of this ISO week —
    // July 20, five days ago — per the documented current-week semantics.
    const saturday = new Date("2026-07-25T15:00:00.000Z");
    expect(resolveOne("since this monday", saturday)).toEqual({
      sourceText: "this monday",
      isoDate: "2026-07-20",
      weekday: "Monday",
    });
    expect(resolveOne("this saturday", saturday).isoDate).toBe("2026-07-25");
  });

  it("resolves 'next <weekday>' to the following ISO week, even on that weekday", () => {
    // Tuesday 2026-07-28: "next tuesday" is a week out, never today.
    const tuesday = new Date("2026-07-28T15:00:00.000Z");
    expect(resolveOne("launch next tuesday", tuesday)).toEqual({
      sourceText: "next tuesday",
      isoDate: "2026-08-04",
      weekday: "Tuesday",
    });
    // Thursday 2026-07-23: "next friday" skips tomorrow for next week's.
    expect(resolveOne("next friday", thursday).isoDate).toBe("2026-07-31");
  });

  it("steps cleanly across the spring-forward DST boundary", () => {
    // Saturday 2026-03-07, 11:30 PM in New York; clocks jump at 2 AM Mar 8.
    const beforeSpring = new Date("2026-03-08T04:30:00.000Z");
    expect(resolveOne("today", beforeSpring).isoDate).toBe("2026-03-07");
    expect(resolveOne("tomorrow", beforeSpring)).toEqual({
      sourceText: "tomorrow",
      isoDate: "2026-03-08",
      weekday: "Sunday",
    });
    expect(resolveOne("next monday", beforeSpring).isoDate).toBe("2026-03-09");
  });

  it("steps cleanly across the fall-back DST boundary", () => {
    // Saturday 2026-10-31, 11:30 PM EDT; clocks fall back at 2 AM Nov 1.
    const beforeFallBack = new Date("2026-11-01T03:30:00.000Z");
    expect(resolveOne("today", beforeFallBack).isoDate).toBe("2026-10-31");
    expect(resolveOne("tomorrow", beforeFallBack)).toEqual({
      sourceText: "tomorrow",
      isoDate: "2026-11-01",
      weekday: "Sunday",
    });
    expect(resolveOne("sunday", beforeFallBack).isoDate).toBe("2026-11-01");
  });

  it("rolls weekday references over a year boundary", () => {
    // Thursday 2026-12-31, evening in New York.
    const yearEnd = new Date("2026-12-31T22:00:00.000Z");
    expect(resolveOne("friday", yearEnd)).toEqual({
      sourceText: "friday",
      isoDate: "2027-01-01",
      weekday: "Friday",
    });
    expect(resolveOne("next friday", yearEnd)).toEqual({
      sourceText: "next friday",
      isoDate: "2027-01-08",
      weekday: "Friday",
    });
  });

  it("rolls 'tomorrow' over a month boundary", () => {
    // Friday 2026-07-31 in New York.
    const monthEnd = new Date("2026-07-31T15:00:00.000Z");
    expect(resolveOne("tomorrow", monthEnd)).toEqual({
      sourceText: "tomorrow",
      isoDate: "2026-08-01",
      weekday: "Saturday",
    });
  });

  it("leaves ambiguous phrases unresolved", () => {
    expect(
      resolveRelativeDateReferences("let's aim for next weekend", thursday, NY),
    ).toEqual([]);
    expect(
      resolveRelativeDateReferences("sometime next week works", thursday, NY),
    ).toEqual([]);
  });

  it("dedupes repeats, keeps first-appearance order, and lowercases sources", () => {
    const refs = resolveRelativeDateReferences(
      "Tomorrow, then NEXT TUESDAY, then tomorrow again",
      thursday,
      NY,
    );
    expect(refs.map((ref) => ref.sourceText)).toEqual([
      "tomorrow",
      "next tuesday",
    ]);
  });

  it("accepts a normalizeUserTimeZone-canonicalized zone", () => {
    const zone = normalizeUserTimeZone("america/new_york");
    expect(zone).toBe(NY);
    expect(resolveOne("today", thursday, zone!).isoDate).toBe("2026-07-23");
  });

  it("degrades to no resolutions when the zone is not formattable", () => {
    expect(
      resolveRelativeDateReferences("tomorrow", thursday, "Not/A_Zone"),
    ).toEqual([]);
  });
});

describe("renderResolvedDateReferences", () => {
  it("renders one compact line and stays silent when there is nothing", () => {
    const now = new Date("2026-07-23T18:00:00.000Z");
    const refs = resolveRelativeDateReferences(
      "today or next tuesday?",
      now,
      NY,
    );
    expect(renderResolvedDateReferences(refs)).toBe(
      "Resolved date references: 'today' = 2026-07-23 (Thursday), 'next tuesday' = 2026-07-28 (Tuesday).",
    );
    expect(renderResolvedDateReferences([])).toBeUndefined();
  });
});
