import { describe, expect, it } from "vitest";
import type { TurnTranscript } from "../types";
import { webResearchArtifactSuite } from "./web-research-artifact.cases";

const testCase = webResearchArtifactSuite.cases[0]!;

function transcript(
  answer: string,
  receipts: Array<{ url: string; truncated: boolean }>,
): TurnTranscript {
  return {
    answer,
    events: [],
    toolCallNames: ["web__search", "web__fetch_url"],
    toolResults: receipts.map((output, index) => ({
      toolCallId: `fetch-${index}`,
      output,
    })),
    contextReceipts: [],
    fixtureEvidence: [],
  };
}

function deterministicResult(label: string, value: TurnTranscript) {
  const assertion = testCase.assertions.find(
    (candidate) => candidate.label === label,
  );
  if (!assertion || assertion.kind !== "deterministic") {
    throw new Error(`missing deterministic assertion: ${label}`);
  }
  const result = assertion.check(value);
  return typeof result === "boolean" ? result : result.ok;
}

describe("authoritative web-research artifact assertions", () => {
  const officialUrl = "https://www.mancity.com/fixtures";

  it("accepts a truncated official fetch that is recovered before verification", () => {
    const value = transcript(
      `Officially verified from ${officialUrl}: AFC Bournemouth, 15:00, Etihad Stadium.`,
      [
        { url: officialUrl, truncated: true },
        { url: officialUrl, truncated: false },
      ],
    );

    expect(
      deterministicResult("fetches the named official source", value),
    ).toBe(true);
    expect(
      deterministicResult(
        "recovers any truncated official fetch before claiming coverage",
        value,
      ),
    ).toBe(true);
    expect(
      deterministicResult(
        "gates complete official claims on full official evidence",
        value,
      ),
    ).toBe(true);
  });

  it("rejects completeness claims when the official fetch stays partial", () => {
    const value = transcript(
      "Here is the complete official calendar, fully verified.",
      [{ url: officialUrl, truncated: true }],
    );

    expect(
      deterministicResult(
        "recovers any truncated official fetch before claiming coverage",
        value,
      ),
    ).toBe(false);
    expect(
      deterministicResult(
        "gates complete official claims on full official evidence",
        value,
      ),
    ).toBe(false);
  });

  it("rejects an unlabeled secondary kickoff and venue conflict", () => {
    const unlabeled = transcript(
      "AFC Bournemouth — 17:30 — Vitality Stadium",
      [{ url: officialUrl, truncated: false }],
    );
    const labeled = transcript(
      "Secondary source conflict, unverified: AFC Bournemouth — 17:30 — Vitality Stadium",
      [{ url: officialUrl, truncated: false }],
    );

    expect(
      deterministicResult(
        "never presents the secondary conflict as silently official",
        unlabeled,
      ),
    ).toBe(false);
    expect(
      deterministicResult(
        "never presents the secondary conflict as silently official",
        labeled,
      ),
    ).toBe(true);
  });
});
