import { describe, expect, it } from "vitest";
import {
  buildExactOutputContract,
  EXACT_OUTPUT_CONTRACT,
} from "./exact-output";

describe("buildExactOutputContract", () => {
  it.each([
    "Return exactly two Markdown bullets.",
    "Reply exactly: Launch date: 31/07/2026.",
    "Use these sentences verbatim and add nothing else.",
    "Return only valid JSON with the three requested keys.",
    "Put the answer in a code block only.",
    "Provide the exact text with no preamble or closing.",
  ])("activates for an explicit output contract: %s", (message) => {
    expect(buildExactOutputContract(message)).toBe(EXACT_OUTPUT_CONTRACT);
  });

  it.each([
    "What exactly happened?",
    "Where exactly is the document?",
    "I only need help deciding what to prioritize.",
    "Give me a concise summary.",
  ])("stays off for ordinary conversational language: %s", (message) => {
    expect(buildExactOutputContract(message)).toBeUndefined();
  });

  it("defines the structural boundaries reported in #652", () => {
    expect(EXACT_OUTPUT_CONTRACT).toContain("real Markdown list syntax");
    expect(EXACT_OUTPUT_CONTRACT).toContain("valid JSON");
    expect(EXACT_OUTPUT_CONTRACT).toContain("exactly the requested keys");
    expect(EXACT_OUTPUT_CONTRACT).toContain("punctuation");
    expect(EXACT_OUTPUT_CONTRACT).toContain("Unicode spacing");
    expect(EXACT_OUTPUT_CONTRACT).toContain("Approved memory");
  });
});
