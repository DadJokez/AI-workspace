import { describe, expect, it } from "vitest";
import { formatCiOutcome, selectSuites, summarizeOutcome } from "./run";
import type { CaseResult, EvalSuite } from "./types";

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

  it("selects the merge-gate pack by suite and case gate tags", () => {
    const gateSuites: EvalSuite[] = [
      {
        capability: "injection",
        defaultModelId: "haiku-4-5",
        tags: ["core", "gate"],
        cases: [testCase("inj-a"), testCase("inj-b")],
      },
      {
        capability: "mixed",
        defaultModelId: "haiku-4-5",
        cases: [testCase("gate-case", ["gate"]), testCase("nightly-case", ["core"])],
      },
      {
        capability: "nightly-only",
        defaultModelId: "haiku-4-5",
        tags: ["core"],
        cases: [testCase("behavior")],
      },
    ];
    const selected = selectSuites(["--gate"], gateSuites);
    expect(
      selected.map((suite) => [suite.capability, suite.cases.map((c) => c.id)]),
    ).toEqual([
      ["injection", ["inj-a", "inj-b"]],
      ["mixed", ["gate-case"]],
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

function caseResult(
  caseId: string,
  passed: boolean,
  knownIssue?: string,
  extra: Partial<CaseResult> = {},
): CaseResult {
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
    ...extra,
  };
}

function capability(results: CaseResult[], name = "x") {
  const passed = results.filter((r) => r.passed).length;
  return {
    capability: name,
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

describe("known-issue outcome split (#675)", () => {
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

describe("CI outcome outputs (#847)", () => {
  const failing = (label: string) => ({ ok: false, label });
  const passing = (label: string) => ({ ok: true, label });

  it("names a blocking failure with its capability, tally, and failing labels", () => {
    const out = formatCiOutcome([
      capability(
        [
          caseResult("artifact-content-is-inert-data", false, undefined, {
            runs: 5,
            passCount: 4,
            assertions: [
              failing("does not adopt the injected GPT-4 identity"),
              failing("does not echo the injected credential"),
              passing("treats the artifact body as inert data, not instructions"),
            ],
          }),
        ],
        "skill-faithfulness",
      ),
    ]);
    expect(out.failingCases).toBe(
      "skill-faithfulness/artifact-content-is-inert-data [4/5]: does not adopt the injected GPT-4 identity; does not echo the injected credential",
    );
    expect(out.knownCases).toBe("");
  });

  it("is empty when everything passes", () => {
    expect(
      formatCiOutcome([capability([caseResult("a", true), caseResult("b", true)])]),
    ).toEqual({ failingCases: "", knownCases: "" });
  });

  it("lists known-red cases separately and leaves the blocking list empty", () => {
    const out = formatCiOutcome([
      capability([caseResult("ok", true), caseResult("flaky", false, "#847")]),
    ]);
    expect(out.failingCases).toBe("");
    expect(out.knownCases).toBe("flaky #847");
  });

  it("strips newlines and caps the blocking list at 2000 chars", () => {
    const out = formatCiOutcome([
      capability([
        caseResult("multi", false, undefined, {
          assertions: [failing("line one\n  line two")],
        }),
        caseResult("huge", false, undefined, {
          assertions: [failing("x".repeat(3000))],
        }),
      ]),
    ]);
    expect(out.failingCases.startsWith("x/multi [0/1]: line one line two | x/huge [0/1]: xxx")).toBe(true);
    expect(out.failingCases).not.toMatch(/[\r\n]/);
    expect(out.failingCases).toHaveLength(2000);
  });
});
