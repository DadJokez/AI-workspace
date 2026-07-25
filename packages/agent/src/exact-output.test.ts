import { describe, expect, it } from "vitest";
import {
  buildExactOutputContract,
  evaluateLiteralContract,
  extractPureEchoReply,
  EXACT_OUTPUT_CONTRACT,
  EXACT_OUTPUT_MEMORY_ACK,
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
    expect(buildExactOutputContract(message)?.prose).toBe(
      EXACT_OUTPUT_CONTRACT,
    );
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

  describe("literal spec extraction (#652/#644)", () => {
    it.each([
      ['Reply exactly with "CBX-7745-TANGO"', "CBX-7745-TANGO"],
      ["Respond with exactly `ACK-9`.", "ACK-9"],
      ["Say exactly 'Done, thanks!'", "Done, thanks!"],
      // Colon-delimited: everything after the colon, verbatim — inner
      // punctuation, casing, and the final period are part of the literal.
      ["Reply exactly: Launch date: 31/07/2026.", "Launch date: 31/07/2026."],
      ["Answer exactly: CBX-1", "CBX-1"],
      [
        "Remember my favorite color is teal, then reply exactly: ACK-7",
        "ACK-7",
      ],
    ])("extracts the demanded literal from %j", (message, literal) => {
      expect(buildExactOutputContract(message)?.spec).toEqual({
        kind: "literal",
        value: literal,
        // Every fixture above has a clean or side-effect-only prefix.
        reducible: true,
      });
    });

    it("marks a content-producing prefix non-reducible (review: reduction must not discard requested content)", () => {
      for (const message of [
        "Summarize the doc. Reply exactly: done",
        "Draft a decline email, then reply exactly: sent",
        "Remember the launch date and summarize the doc, then reply exactly: ACK-7",
      ]) {
        const spec = buildExactOutputContract(message)?.spec;
        expect(spec?.value).toBeDefined();
        expect(spec?.reducible, message).toBe(false);
      }
    });

    it("keeps a please-prefixed echo reducible", () => {
      expect(
        buildExactOutputContract('Please reply exactly with "CBX-1"')?.spec
          ?.reducible,
      ).toBe(true);
    });

    it("keeps a trailing period outside the quotes out of the literal", () => {
      expect(
        buildExactOutputContract('Reply exactly with "MiXeD-CaSe-42".')?.spec,
      ).toEqual({ kind: "literal", value: "MiXeD-CaSe-42", reducible: true });
    });

    it.each([
      // Undelimited tail: ambiguous, never machine-enforced.
      "reply exactly ACK and also summarize the doc",
      // Quoted literal that does not end the message: ambiguous too.
      'Reply exactly with "ACK" and then summarize the doc',
      // Contract prose without a demanded reply literal at all.
      "Return exactly two Markdown bullets.",
      "Reply with exactly these two sentences and nothing else: The pilot is ready. Mobile QA is blocked.",
    ])("returns prose without a spec for %j", (message) => {
      const contract = buildExactOutputContract(message);
      expect(contract).toBeDefined();
      expect(contract?.spec).toBeUndefined();
    });
  });

  describe("memory-request honesty suffix", () => {
    it("appends the queued-capture sentence when a literal and a memory ask coexist", () => {
      const contract = buildExactOutputContract(
        "Remember my favorite color is teal, then reply exactly: ACK-7",
      );
      expect(contract?.prose).toBe(
        `${EXACT_OUTPUT_CONTRACT} ${EXACT_OUTPUT_MEMORY_ACK}`,
      );
      expect(EXACT_OUTPUT_MEMORY_ACK).toContain("later review");
    });

    it("keeps the plain contract when no memory ask is present", () => {
      expect(
        buildExactOutputContract('Reply exactly with "CBX-7745-TANGO"')?.prose,
      ).toBe(EXACT_OUTPUT_CONTRACT);
    });

    it("keeps the plain contract when there is no enforceable literal", () => {
      expect(
        buildExactOutputContract(
          "Remember this and return exactly two Markdown bullets.",
        )?.prose,
      ).toBe(EXACT_OUTPUT_CONTRACT);
    });
  });
});

describe("extractPureEchoReply", () => {
  it.each([
    ['Reply exactly with "CBX-7745-TANGO"', "CBX-7745-TANGO"],
    ["Respond with exactly `ACK-9`.", "ACK-9"],
    ["Please reply exactly: ACK-7", "ACK-7"],
    ["say exactly 'ok then'", "ok then"],
    ['Reply exactly: "Spaced literal here"', "Spaced literal here"],
  ])("answers %j deterministically with %j", (message, literal) => {
    expect(extractPureEchoReply(message)).toBe(literal);
  });

  it.each([
    // Additional clause: normal model path.
    "reply exactly ACK and also summarize the doc",
    'Reply exactly with "ACK" and then summarize the doc',
    // Content before the demand beyond "please": normal model path.
    "Remember my favorite color is teal, then reply exactly: ACK-7",
    "Summarize the doc. Reply exactly: done",
    // Colon-delimited multi-word tail is ambiguous without quotes.
    "Reply exactly: ACK then delete my files",
    "Reply exactly: Launch date: 31/07/2026.",
    // No echo demand at all.
    "What exactly happened?",
    "Give me a concise summary.",
    "",
  ])("stays off for %j", (message) => {
    expect(extractPureEchoReply(message)).toBeUndefined();
  });
});

describe("evaluateLiteralContract", () => {
  it("passes a byte-exact answer", () => {
    expect(evaluateLiteralContract("CBX-7745-TANGO", "CBX-7745-TANGO")).toBe(
      "exact",
    );
  });

  it("reduces a literal wrapped in prose or whitespace", () => {
    expect(
      evaluateLiteralContract(
        "Sure — here you go: CBX-7745-TANGO. Anything else?",
        "CBX-7745-TANGO",
      ),
    ).toBe("reduced");
    expect(evaluateLiteralContract("ACK-7\n", "ACK-7")).toBe("reduced");
  });

  it("treats casing and punctuation drift as a violation, not a match", () => {
    expect(evaluateLiteralContract("cbx-7745-tango", "CBX-7745-TANGO")).toBe(
      "violated",
    );
    expect(evaluateLiteralContract("ACK 7", "ACK-7")).toBe("violated");
  });

  it("never reduces on an incidental substring or short common literal (review)", () => {
    // "no" inside "cannot": a refusal must not be rewritten into compliance.
    expect(
      evaluateLiteralContract("I cannot store preferences right now.", "no"),
    ).toBe("present");
    // Even standalone, a short common word is not distinctive enough to
    // replace what the model actually said.
    expect(
      evaluateLiteralContract("No, that is not something I can do.", "no"),
    ).toBe("present");
    expect(evaluateLiteralContract("look at this: ok", "ok")).toBe("present");
    // Distinctive literals still reduce when framed…
    expect(
      evaluateLiteralContract("Sure — here you go: ACK-7", "ACK-7"),
    ).toBe("reduced");
    // …but not when only embedded inside a larger token.
    expect(
      evaluateLiteralContract("The id is XACK-77 today.", "ACK-7"),
    ).toBe("present");
  });

  it("reports 'present' beyond the framing allowance instead of discarding content", () => {
    const summary =
      "The document covers the Q3 migration in detail. ".repeat(8) +
      "In short, the migration is done.";
    expect(evaluateLiteralContract(summary, "done")).toBe("present");
    // "done" fails the distinctiveness floor, so even a framed occurrence
    // stays as-generated; only distinctive literals reduce.
    expect(
      evaluateLiteralContract("Sure thing — here it is: done", "done"),
    ).toBe("present");
    expect(
      evaluateLiteralContract("Sure thing — here it is: ACK-7", "ACK-7"),
    ).toBe("reduced");
  });

  it("flags an absent literal without inventing it", () => {
    expect(
      evaluateLiteralContract(
        "I can't repeat that token for security reasons.",
        "CBX-7745-TANGO",
      ),
    ).toBe("violated");
  });
});
