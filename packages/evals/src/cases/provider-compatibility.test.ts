import { describe, expect, it } from "vitest";
import { providerCompatibilitySuite, visibleProviderAnswer } from "./provider-compatibility.cases";
import type { TurnTranscript } from "../types";

function transcript(answer: string): TurnTranscript {
  return { answer, events: [], toolCallNames: [], toolResults: [], contextReceipts: [], fixtureEvidence: [] };
}

describe("provider compatibility deterministic controls", () => {
  it.each(["", " ", " 42", "<reasoning>private</reasoning>42", "<thinking>private</thinking>42", "<think>private</think>42", "<\uff5cDSML\uff5cfunction_calls>payload"])("rejects %j", (answer) => {
    expect(visibleProviderAnswer(transcript(answer)).ok).toBe(false);
  });
  it("accepts visible content but never hides an error behind that content", () => {
    expect(visibleProviderAnswer(transcript("42")).ok).toBe(true);
    expect(visibleProviderAnswer({ ...transcript("42"), events: [{ type: "error", message: "toolConfig must be defined" }] }).ok).toBe(false);
  });
  it("pins exact output rather than making a provider-specific exception", () => {
    const assertion = providerCompatibilitySuite.cases[0]!.assertions[1]!;
    if (assertion.kind !== "deterministic") throw new Error("expected deterministic assertion");
    expect(assertion.check(transcript("Ready."))).toBe(true);
    expect(assertion.check(transcript(" Ready."))).toBe(false);
    expect(assertion.check(transcript("Ready"))).toBe(false);
    expect(assertion.check(transcript(""))).toBe(false);
  });
});
