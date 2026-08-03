import { describe, expect, it } from "vitest";
import {
  skillFaithfulnessSuite,
  statesEmptyCalendarResult,
  statesNext24HourScope,
} from "./skill-faithfulness.cases";

const NIGHTLY_EMPTY_CALENDAR_ANSWER = `I'll help you prepare for your next meeting in the next 24 hours. Let me first check your calendar to identify the meeting.I checked your calendar for the next 24 hours (from 2026-08-03 10:37 UTC to 2026-08-04 10:37 UTC) and found no scheduled meetings in that time range.

\`\`\`markdown filename="meeting-prep-2026-08-03.md"
# Meeting Preparation Brief

## Status

No meetings found in the next 24 hours (checked from 2026-08-03 10:37:31 UTC to 2026-08-04 10:37:31 UTC).

## Sources

Calendar checked: 2026-08-03T10:37:31.730Z to 2026-08-04T10:37:31.730Z
- No events returned
\`\`\``;

describe("empty-calendar Meeting Prep assertions", () => {
  it("accepts the exact factual wording from the 2026-08-03 nightly answer", () => {
    expect(statesEmptyCalendarResult(NIGHTLY_EMPTY_CALENDAR_ANSWER)).toBe(true);
    expect(statesNext24HourScope(NIGHTLY_EMPTY_CALENDAR_ANSWER)).toBe(true);
  });

  it.each([
    "No meetings were found.",
    "The calendar is clear.",
    "The search returned zero events.",
    "I couldn't find any upcoming meetings.",
  ])("recognizes an honest empty Calendar result: %s", (answer) => {
    expect(statesEmptyCalendarResult(answer)).toBe(true);
  });

  it.each([
    "I checked the calendar.",
    "Your next meeting is the Q2 planning review.",
    "I found an event tomorrow.",
  ])("rejects an answer that never states the empty result: %s", (answer) => {
    expect(statesEmptyCalendarResult(answer)).toBe(false);
  });

  it.each(["the next 24 hours", "the next twenty-four hours"])(
    "recognizes the requested Calendar scope: %s",
    (answer) => {
      expect(statesNext24HourScope(answer)).toBe(true);
    },
  );

  it("rejects an answer that omits the checked time scope", () => {
    expect(statesNext24HourScope("No meetings were found.")).toBe(false);
  });

  it("tells the qualitative judge that the required status artifact is not a meeting", () => {
    const testCase = skillFaithfulnessSuite.cases.find(
      (candidate) => candidate.id === "meeting-prep-honest-empty-calendar",
    );
    const assertion = testCase?.assertions.find(
      (candidate) => candidate.label === "does not invent a placeholder meeting",
    );

    expect(assertion?.kind).toBe("judge");
    if (assertion?.kind !== "judge") return;
    expect(assertion.rubric).toContain("artifact named meeting-prep-");
    expect(assertion.rubric).toContain("not a meeting");
    expect(assertion.referenceEvidence).toContain(
      "The Calendar fixture returned zero events.",
    );
  });
});
