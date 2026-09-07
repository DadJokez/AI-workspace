import { describe, expect, it } from "vitest";
import type { EvalSuite } from "../types";
import { foundationalChatSuite } from "./foundational-chat.cases";
import { fileResourceGroundingSuite } from "./file-resource-grounding.cases";
import { gmailCalendarFaithfulnessSuite } from "./gmail-calendar-faithfulness.cases";

function result(suite: EvalSuite, id: string, label: string, answer: string) {
  const assertion = suite.cases.find((c) => c.id === id)?.assertions.find((a) => a.label === label);
  if (assertion?.kind !== "deterministic") throw new Error(`Missing deterministic assertion: ${id}/${label}`);
  const actual = assertion.check({ answer, events: [], toolCallNames: [], toolResults: [], contextReceipts: [], fixtureEvidence: [] });
  return typeof actual === "boolean" ? actual : actual.ok;
}

describe("fact comparisons across typography", () => {
  const controls = [
    [foundationalChatSuite, "preserves-brief-facts", "includes every material fact from the brief", "Alder & Finch: $184,250; decision 2026-08-14; verbally approved, contract not signed.", "184,250"],
    [foundationalChatSuite, "newer-correction-wins", "uses the corrected project and date", "Orion launches October 18, 2026.", "18"],
    [foundationalChatSuite, "follow-up-reference-resolution", "resolves the owner and due date from conversation history", "Priya Shah owns it, due August 29, 2026.", "29"],
    [foundationalChatSuite, "conflicting-sources-are-surfaced", "shows both conflicting dates", "September 18, 2026 conflicts with September 21, 2026.", "21"],
    [foundationalChatSuite, "requested-structure-preserves-facts", "includes every owner and due date", "Priya 2026-08-29; Marco 2026-09-02; Nina 2026-09-04", "09-04"],
    [fileResourceGroundingSuite, "csv-sort-top-row", "identifies the correct top customer and value", "Meridian Health: 73,006.", "73,006"],
    [fileResourceGroundingSuite, "document-search-grounding", "answers with exact document facts", "Priya Shah; 2026-09-17", "09-17"],
    [fileResourceGroundingSuite, "document-risk-detail", "reports the exact risk and due date", "Vendor security review due 2026-08-29", "08-29"],
    [fileResourceGroundingSuite, "file-follow-up-still-queries-resource", "answers the follow-up with the retained row", "At Risk", "Risk"],
    [fileResourceGroundingSuite, "document-complete-fact-set", "preserves the complete requested fact set", "Priya Shah; 2026-09-17; 284,500; twelve design partners; vendor security review due 2026-08-29", "09-17"],
  ] as const;
  for (const [suite, id, label, answer, fact] of controls) it(`accepts typography, rejects a changed fact: ${id}`, () => {
    for (const space of [" ", "\u00a0", "\u202f"]) {
      const typography = (value: string) => value.replace(/ /g, space).replace(/-/g, "\u2011") + "\r\n";
      expect(result(suite, id, label, typography(answer))).toBe(true);
      expect(result(suite, id, label, typography(answer.replace(fact, "WRONG")))).toBe(false);
    }
  });
});

describe("calendar timezone labels", () => {
  const matches = (value: unknown) => result(gmailCalendarFaithfulnessSuite, "calendar-time-zone-labels", "labels UTC and local calendar times consistently", JSON.stringify(value));
  const correct = { localStart: "2026-07-10T15:00", timeZone: "America/New_York", utcStart: "2026-07-10T19:00:00Z" };
  it("accepts the correct local/UTC pair", () => expect(matches(correct)).toBe(true));
  it("rejects prose or fences around an otherwise correct JSON pair", () => {
    for (const answer of ["```json\n" + JSON.stringify(correct) + "\n```", "Here: " + JSON.stringify(correct)]) {
      expect(result(gmailCalendarFaithfulnessSuite, "calendar-time-zone-labels", "labels UTC and local calendar times consistently", answer)).toBe(false);
    }
  });
  it.each([
    { ...correct, localStart: "2026-07-10T19:00" },
    { ...correct, timeZone: "UTC" },
    { ...correct, utcStart: "2026-07-10T15:00:00Z" },
    { ...correct, localStart: "2026-07-11T15:00" },
    null,
    [],
  ])("rejects missing, shifted or mislabeled instants: %j", (value) => expect(matches(value)).toBe(false));
});
