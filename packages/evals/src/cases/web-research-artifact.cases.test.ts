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
  const officialRows = [
    ["2026-08-15", "AFC Bournemouth", "15:00", "Etihad Stadium"],
    ["2026-08-22", "Brighton", "12:30", "Amex Stadium"],
    ["2026-08-29", "West Ham", "17:30", "Etihad Stadium"],
    ["2026-09-12", "Everton", "15:00", "Hill Dickinson Stadium"],
    ["2026-09-19", "Arsenal", "16:30", "Etihad Stadium"],
    ["2026-09-26", "Fulham", "15:00", "Craven Cottage"],
    ["2026-10-03", "Newcastle", "12:30", "Etihad Stadium"],
    ["2026-10-17", "Chelsea", "17:30", "Stamford Bridge"],
    ["2026-10-24", "Leeds United", "15:00", "Etihad Stadium"],
    ["2026-10-31", "Liverpool", "16:30", "Anfield"],
  ];

  function calendarArtifact(
    rows = officialRows,
    sourceUrl = officialUrl,
  ) {
    return [
      "```html",
      "<!DOCTYPE html>",
      "<html><body>",
      `<a href="${sourceUrl}">Official source</a>`,
      "<table><tbody>",
      ...rows.map(
        ([date, opponent, kickoff, venue]) =>
          `<tr><td>${date}</td><td>${opponent}</td><td>${kickoff}</td><td>${venue}</td></tr>`,
      ),
      "</tbody></table>",
      "</body></html>",
      "```",
    ].join("\n");
  }

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

  it("accepts a complete, sourced calendar with every official row", () => {
    const value = transcript(calendarArtifact(), [
      { url: officialUrl, truncated: false },
    ]);

    expect(
      deterministicResult(
        "builds an auditable calendar from authoritative evidence",
        value,
      ),
    ).toBe(true);
  });

  it("accepts common human-readable date formats", () => {
    const rows = officialRows.map((row, index) =>
      index === 0 ? ["August 15, 2026", ...row.slice(1)] : row,
    );
    const value = transcript(calendarArtifact(rows), [
      { url: officialUrl, truncated: false },
    ]);

    expect(
      deterministicResult(
        "builds an auditable calendar from authoritative evidence",
        value,
      ),
    ).toBe(true);
  });

  it("rejects missing, conflicting, extra, unsourced, or incomplete rows", () => {
    const cases = [
      calendarArtifact(officialRows.slice(0, -1)),
      calendarArtifact(
        officialRows.map((row, index) =>
          index === 0
            ? [row[0]!, row[1]!, "17:30", "Vitality Stadium"]
            : row,
        ),
      ),
      calendarArtifact([
        ...officialRows,
        ["2026-11-07", "Invented FC", "15:00", "Etihad Stadium"],
      ]),
      calendarArtifact(officialRows, "https://example.com/fixtures"),
      calendarArtifact().replace("</html>\n```", "```"),
    ];

    for (const answer of cases) {
      expect(
        deterministicResult(
          "builds an auditable calendar from authoritative evidence",
          transcript(answer, [{ url: officialUrl, truncated: false }]),
        ),
      ).toBe(false);
    }
  });
});
