import { describe, expect, it } from "vitest";
import { selectSuites, summarizeOutcome } from "./run";
import type { EvalSuite } from "./types";

function testCase(id: string, tags?: readonly string[]) {
  return {
    id,
    description: id,
    input: id,
    ...(tags ? { tags } : {}),
    assertions: [
      {
        kind: "deterministic" as const,
        label: "ok",
        check: () => true,
      },
    ],
  };
}

const suites: EvalSuite[] = [
  {
    capability: "suite-core",
    defaultModelId: "haiku-4-5",
    tags: ["core"],
    cases: [testCase("a"), testCase("b")],
  },
  {
    capability: "case-core",
    defaultModelId: "haiku-4-5",
    cases: [testCase("c", ["core"]), testCase("d", ["advanced"])],
  },
  {
    capability: "advanced-only",
    defaultModelId: "haiku-4-5",
    cases: [testCase("e", ["advanced"])],
  },
];

describe("eval suite selection", () => {
  it("keeps the bare command as the complete suite", () => {
    expect(selectSuites([], suites).map((suite) => suite.capability)).toEqual([
      "suite-core",
      "case-core",
      "advanced-only",
    ]);
    expect(selectSuites([], suites).flatMap((suite) => suite.cases)).toHaveLength(
      5,
    );
  });

  it("selects suite-level and case-level core tags", () => {
    const selected = selectSuites(["--core"], suites);

    expect(selected.map((suite) => suite.capability)).toEqual([
      "suite-core",
      "case-core",
    ]);
    expect(
      selected.map((suite) => [
        suite.capability,
        suite.cases.map((testCase) => testCase.id),
      ]),
    ).toEqual([
      ["suite-core", ["a", "b"]],
      ["case-core", ["c"]],
    ]);
  });

  it("combines a capability filter with core selection", () => {
    expect(
      selectSuites(["case-core", "--core"], suites)[0]?.cases.map(
        (testCase) => testCase.id,
      ),
    ).toEqual(["c"]);
    expect(selectSuites(["advanced-only", "--core"], suites)).toEqual([]);
  });
});

describe("known-issue outcome split (#675)", () => {
  function caseResult(
    caseId: string,
    passed: boolean,
    knownIssue?: string,
  ) {
    return {
      caseId,
      description: caseId,
      severity: "critical" as const,
      tags: [],
      modelId: "haiku-4-5" as const,
      threadId: "t",
      runId: "r",
      passed,
      assertions: [],
      answer: "",
      answerPreview: "",
      tokensIn: 0,
      tokensOut: 0,
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      toolCalls: [],
      toolResults: [],
      contextReceipts: [],
      fixtureEvidence: [],
      judgeUsage: {
        tokensIn: 0,
        tokensOut: 0,
        inputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      ...(knownIssue ? { knownIssue } : {}),
    };
  }

  function capability(results: ReturnType<typeof caseResult>[]) {
    const passed = results.filter((r) => r.passed).length;
    return {
      capability: "x",
      results,
      passed,
      failed: results.length - passed,
      bySeverity: {
        critical: { passed, failed: results.length - passed },
        high: { passed: 0, failed: 0 },
        medium: { passed: 0, failed: 0 },
        low: { passed: 0, failed: 0 },
      },
    };
  }

  it("a known-issue failure is reported but does not fail the run", () => {
    const outcome = summarizeOutcome([
      capability([
        caseResult("ok", true),
        caseResult("flaky", false, "#675"),
      ]),
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.blockingFailed).toBe(0);
    expect(outcome.knownFailed).toEqual([
      { caseId: "flaky", knownIssue: "#675" },
    ]);
  });

  it("an unmarked failure still fails the run even beside known-red cases", () => {
    const outcome = summarizeOutcome([
      capability([
        caseResult("flaky", false, "#675"),
        caseResult("regression", false),
      ]),
    ]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.blockingFailed).toBe(1);
  });

  it("a passing known-issue case is just a pass", () => {
    const outcome = summarizeOutcome([
      capability([caseResult("flaky", true, "#675")]),
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.knownFailed).toEqual([]);
  });
});
