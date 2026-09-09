import { describe, expect, it } from "vitest";
import { retainSample } from "./sample-evidence";
import { reportSamples } from "./judge-replay";
import type { CaseResult, SampleResult } from "./types";

const fixture: SampleResult = {
  sampleId: "sample:1", modelId: "sonnet-4-5", passed: false,
  answer: "The request failed.", toolCalls: [], toolResults: [],
  assertions: [{ label: "correct", ok: false }],
  tokensIn: 10, tokensOut: 5, inputTokens: 10, cacheReadInputTokens: 0, cacheWriteInputTokens: 0,
  judgeUsage: { tokensIn: 0, tokensOut: 0, inputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
};

describe("retained repeat evidence", () => {
  it("preserves ordinary evidence without changing verdicts or usage", () => {
    expect(retainSample(fixture)).toEqual(fixture);
  });

  it("redacts credential-shaped fixture strings in nested fields, without mutating the original", () => {
    const secret = `ghp_${"x".repeat(30)}`;
    const source = { ...fixture, answer: `token=${secret}`, errored: `Bearer ${secret}` };
    const saved = retainSample(source);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(saved.evidenceTransformed).toBe(true);
    expect(source.answer).toContain(secret);
    expect(saved.passed).toBe(false);
  });

  it("bounds oversized answers and marks them unsuitable for raw replay", () => {
    const saved = retainSample({ ...fixture, answer: "x".repeat(40_000) });
    expect(saved.answer).toHaveLength(32_000);
    expect(saved.evidenceTransformed).toBe(true);
    expect(() => reportSamples({ caseId: "bounded", samples: [saved] } as CaseResult)).toThrow("cannot be replayed");
  });

  it("replays every repeat including losses hidden by a majority pass", () => {
    const samples = [ { ...fixture, sampleId: "1", passed: true }, { ...fixture, sampleId: "2" }, { ...fixture, sampleId: "3", passed: true } ];
    expect(reportSamples({ samples } as CaseResult)).toEqual(samples);
  });

  it("keeps legacy representative reports readable", () => {
    const legacy = { ...fixture, sampleId: undefined, caseId: "legacy" } as unknown as CaseResult;
    expect(reportSamples(legacy)).toEqual([legacy]);
  });
});
