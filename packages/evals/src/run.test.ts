import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  type BedrockClient,
  type BedrockStreamEvent,
  type ConverseStreamParams,
} from "@ai-workspace/agent";
import { runSuite } from "./harness";
import { JUDGE_MODEL_ID } from "./judge";
import {
  applyModelOverride,
  formatCiOutcome,
  parseRunArgs,
  resolveRunModels,
  selectSuites,
  summarizeOutcome,
} from "./run";
import { buildScorecard } from "./scorecard";
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

describe("--model qualification runs (#797 P2)", () => {
  it("parses --model and --model= without eating the capability filter", () => {
    expect(parseRunArgs(["--mock", "--model", "opus-4-7", "date-grounding"])).toEqual({
      mock: true,
      gate: false,
      core: false,
      filter: "date-grounding",
      modelId: "opus-4-7",
    });
    expect(parseRunArgs(["date-grounding", "--model=haiku-4-5", "--gate"])).toMatchObject({
      gate: true,
      filter: "date-grounding",
      modelId: "haiku-4-5",
    });
    expect(parseRunArgs(["--baseline", "eval-reports/x.json"]).baselinePath).toBe(
      "eval-reports/x.json",
    );
    expect(() => parseRunArgs(["--model"])).toThrow(/--model needs a value/);
    expect(() => parseRunArgs(["--model", "--mock"])).toThrow(/--model needs a value/);
  });

  it("the --model value is never mistaken for a capability filter in suite selection", () => {
    expect(
      selectSuites(["--model", "opus-4-7"], suites).map((s) => s.capability),
    ).toEqual(["suite-core", "case-core", "advanced-only"]);
    expect(
      selectSuites(["--model", "opus-4-7", "case-core"], suites).map((s) => s.capability),
    ).toEqual(["case-core"]);
  });

  it("refuses an id that is not in the registry, naming the valid ones", () => {
    expect(() => resolveRunModels({ modelId: "gpt-5.6-terra" })).toThrow(
      /Unknown --model "gpt-5.6-terra".*haiku-4-5, sonnet-4-5, sonnet-4-6, opus-4-7/,
    );
  });

  it("refuses to qualify the judge model with itself", () => {
    expect(() => resolveRunModels({ modelId: JUDGE_MODEL_ID })).toThrow(
      /pinned judge.*never qualify itself/,
    );
  });

  it("the judge id is pinned regardless of --model; the incumbent run is never refused", () => {
    for (const modelId of MODEL_IDS.filter((id) => id !== JUDGE_MODEL_ID)) {
      expect(resolveRunModels({ modelId })).toEqual({
        candidateModelId: modelId,
        judgeModelId: JUDGE_MODEL_ID,
      });
    }
    expect(resolveRunModels({})).toEqual({
      candidateModelId: DEFAULT_MODEL_ID,
      judgeModelId: JUDGE_MODEL_ID,
    });
  });

  it("overrides every suite default and every case-level pin", () => {
    const pinned: EvalSuite[] = [
      {
        capability: "routing",
        defaultModelId: "sonnet-4-6",
        cases: [
          { ...testCase("pinned-default"), modelId: "sonnet-4-6" },
          { ...testCase("pinned-haiku"), modelId: "haiku-4-5" },
          testCase("unpinned"),
        ],
      },
    ];
    const { suites: overridden, overriddenPins } = applyModelOverride(pinned, "opus-4-7");
    expect(overriddenPins).toBe(2);
    expect(overridden[0]!.defaultModelId).toBe("opus-4-7");
    expect(overridden[0]!.cases.map((c) => c.modelId)).toEqual([undefined, undefined, undefined]);
    // The input is not mutated.
    expect(pinned[0]!.cases[1]!.modelId).toBe("haiku-4-5");
  });

  it("a --model run sends candidate turns to the candidate and judge turns to JUDGE_MODEL_ID", async () => {
    // Hard assertion for the judge pin: every Bedrock call is recorded with
    // the model it went to. A candidate override must move the case turns
    // and leave the judge exactly where it was.
    const calls: Array<{ bedrockModelId: string; judge: boolean }> = [];
    const recording: BedrockClient = {
      async *converseStream(params: ConverseStreamParams): AsyncIterable<BedrockStreamEvent> {
        const text = params.messages
          .flatMap((m) => m.content)
          .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
          .map((b) => b.text)
          .join("\n");
        const judge = text.startsWith("RUBRIC:");
        calls.push({ bedrockModelId: params.bedrockModelId, judge });
        yield { type: "text-delta", text: judge ? "PASS\nfine" : "candidate answer" };
        yield { type: "stop", reason: "end_turn" };
      },
    };
    const suite: EvalSuite = {
      capability: "judged",
      defaultModelId: "sonnet-4-6",
      cases: [
        {
          ...testCase("judged-case"),
          modelId: "haiku-4-5",
          assertions: [{ kind: "judge", label: "judged", rubric: "anything" }],
        },
      ],
    };
    const { suites: overridden } = applyModelOverride([suite], "opus-4-7");
    const result = await runSuite(overridden[0]!, { client: recording });

    expect(result.passed).toBe(1);
    expect(result.results[0]!.modelId).toBe("opus-4-7");
    const candidateCalls = calls.filter((c) => !c.judge).map((c) => c.bedrockModelId);
    const judgeCalls = calls.filter((c) => c.judge).map((c) => c.bedrockModelId);
    expect(candidateCalls).toEqual([MODELS["opus-4-7"].bedrockModelId]);
    expect(judgeCalls).toEqual([MODELS[JUDGE_MODEL_ID].bedrockModelId]);
    expect(MODELS["opus-4-7"].bedrockModelId).not.toBe(MODELS[JUDGE_MODEL_ID].bedrockModelId);
  });

  it("the report meta and scorecard carry both ids so a report can never hide who graded", () => {
    const { candidateModelId, judgeModelId } = resolveRunModels({ modelId: "opus-4-7" });
    const card = buildScorecard({
      candidateModelId,
      judgeModelId,
      results: [capability([caseResult("a", true)])],
      mock: true,
      generationCostUsd: 0,
    });
    expect(card).toMatchObject({
      candidateModelId: "opus-4-7",
      judgeModelId: JUDGE_MODEL_ID,
      mock: true,
      verdict: "incomplete",
    });
    expect(card.bar.find((b) => b.id === "judge-independence")).toMatchObject({ ok: true });
  });
});
