import {
  type AgentEvent,
  type BedrockClient,
  type TokenUsage,
  ToolRegistry,
  createDiscoveryTools,
  getBedrockClient,
  resolveMountedToolNames,
  runAgentLoop,
} from "@ai-workspace/agent";
import type {
  AssertionResult,
  CapabilityResult,
  CaseResult,
  EvalCase,
  EvalSeverity,
  EvalSuite,
  TurnTranscript,
} from "./types";
import { runJudge } from "./judge";

const EVAL_MAX_TOKENS = 4_096;

/**
 * Run one turn through the real agent loop and capture everything assertions
 * need. This is deliberately the *same* `runAgentLoop` production uses — the
 * harness tests real model behavior (the Christmas-class bug), not a
 * reimplementation.
 */
async function runTurn(
  client: BedrockClient,
  testCase: EvalCase,
  defaultModelId: EvalSuite["defaultModelId"],
): Promise<TurnTranscript & TokenUsage> {
  const events: AgentEvent[] = [];
  let answer = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let inputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  const toolCallNames: string[] = [];
  const toolResults: TurnTranscript["toolResults"] = [];
  const registry = new ToolRegistry();
  registry.registerAll(testCase.tools ?? []);
  // #384 P2: discovery-enabled cases run the production wiring — shared
  // activated set, sticky activation, per-iteration bundle resolution.
  let resolveAllowedTools: (() => readonly string[] | undefined) | undefined;
  if (testCase.toolDiscovery) {
    const activated = new Set(testCase.toolDiscovery.activatedProviders ?? []);
    registry.registerAll(
      createDiscoveryTools({
        catalog: testCase.toolDiscovery.catalog,
        activatedProviders: activated,
      }),
    );
    const dynamicToolNames = new Set(
      testCase.toolDiscovery.dynamicToolNames ?? [],
    );
    resolveAllowedTools = () =>
      resolveMountedToolNames(
        registry.list().map((tool) => tool.name),
        dynamicToolNames,
        activated,
      );
  }

  for await (const ev of runAgentLoop({
    modelId: testCase.modelId ?? defaultModelId,
    systemPrompt: testCase.systemPrompt,
    ...(testCase.userTimeZone ? { userTimeZone: testCase.userTimeZone } : {}),
    messages: testCase.messages ?? [{ role: "user", content: testCase.input }],
    registry,
    ...(resolveAllowedTools ? { resolveAllowedTools } : {}),
    context: { userId: "eval" },
    maxTokens: EVAL_MAX_TOKENS,
    client,
  })) {
    events.push(ev);
    if (ev.type === "text-delta") answer += ev.delta;
    else if (ev.type === "tool-call") toolCallNames.push(ev.call.name);
    else if (ev.type === "tool-result") toolResults.push(ev.result);
    else if (ev.type === "usage") {
      tokensIn = ev.tokensIn;
      tokensOut = ev.tokensOut;
      inputTokens = ev.inputTokens;
      cacheReadInputTokens = ev.cacheReadInputTokens;
      cacheWriteInputTokens = ev.cacheWriteInputTokens;
    }
  }

  return {
    answer,
    events,
    toolCallNames,
    toolResults,
    providerStatus: testCase.providerStatus,
    contextReceipts: testCase.contextReceipts ?? [],
    fixtureEvidence: testCase.fixtureEvidence ?? [],
    tokensIn,
    tokensOut,
    inputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
  };
}

function summarizeToolResults(
  toolResults: TurnTranscript["toolResults"],
): CaseResult["toolResults"] {
  return toolResults.map((result) => ({
    toolCallId: result.toolCallId,
    isError: result.isError,
    outputPreview: previewOutput(result.output),
  }));
}

function previewOutput(output: unknown): string {
  const raw = typeof output === "string" ? output : JSON.stringify(output);
  return (raw ?? String(output)).slice(0, 500);
}

/** One transcript plus its evaluated assertions. */
interface SingleRunResult {
  transcript?: TurnTranscript & TokenUsage;
  assertions: AssertionResult[];
  passed: boolean;
  judgeUsage: TokenUsage;
  errored?: string;
}

const EMPTY_USAGE: TokenUsage = {
  tokensIn: 0,
  tokensOut: 0,
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
};

/**
 * A failed case is excused (non-blocking, see summarizeOutcome) only when its
 * failure is wholly explained by known-flaky assertions: every failing
 * assertion in every failing run carries `knownIssue`, and no run errored —
 * an infra error (💥) is never excused. Returns the distinct issue refs
 * comma-joined, or undefined when the failure must block. Exported for tests.
 */
export function resolveKnownIssue(
  runs: readonly Pick<SingleRunResult, "assertions" | "passed" | "errored">[],
): string | undefined {
  if (runs.some((run) => run.errored)) return undefined;
  const failingAssertions = runs
    .filter((run) => !run.passed)
    .flatMap((run) => run.assertions.filter((a) => !a.ok));
  if (failingAssertions.length === 0) return undefined;
  if (!failingAssertions.every((a) => a.knownIssue)) return undefined;
  const refs = Array.from(
    new Set(failingAssertions.map((a) => a.knownIssue!)),
  ).sort();
  return refs.join(", ");
}

async function runOnce(
  client: BedrockClient,
  judgeClient: BedrockClient,
  testCase: EvalCase,
  defaultModelId: EvalSuite["defaultModelId"],
): Promise<SingleRunResult> {
  let transcript: TurnTranscript & TokenUsage;
  try {
    transcript = await runTurn(client, testCase, defaultModelId);
  } catch (err) {
    return {
      assertions: [],
      passed: false,
      judgeUsage: { ...EMPTY_USAGE },
      errored: err instanceof Error ? err.message : String(err),
    };
  }

  const assertions: AssertionResult[] = [];
  let judgeUsage = { ...EMPTY_USAGE };
  for (const assertion of testCase.assertions) {
    if (assertion.kind === "deterministic") {
      const raw = assertion.check(transcript);
      const result = typeof raw === "boolean" ? { ok: raw } : raw;
      assertions.push({
        ok: result.ok,
        label: assertion.label,
        detail: result.detail,
        ...(assertion.knownIssue ? { knownIssue: assertion.knownIssue } : {}),
      });
    } else {
      const verdict = await runJudge(judgeClient, {
        rubric: assertion.rubric,
        answer: transcript.answer,
        referenceEvidence: [
          ...(testCase.fixtureEvidence ?? []),
          ...(assertion.referenceEvidence ?? []),
        ],
      });
      judgeUsage = addUsage(judgeUsage, verdict);
      assertions.push({
        ok: verdict.pass,
        label: assertion.label,
        detail: verdict.reason,
        ...(assertion.knownIssue ? { knownIssue: assertion.knownIssue } : {}),
      });
    }
  }

  return {
    transcript,
    assertions,
    passed: assertions.every((a) => a.ok),
    judgeUsage,
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    tokensIn: left.tokensIn + right.tokensIn,
    tokensOut: left.tokensOut + right.tokensOut,
    inputTokens: left.inputTokens + right.inputTokens,
    cacheReadInputTokens:
      left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheWriteInputTokens:
      left.cacheWriteInputTokens + right.cacheWriteInputTokens,
  };
}

function sumUsage(runs: readonly SingleRunResult[]): TokenUsage {
  return runs.reduce<TokenUsage>((acc, run) => {
    const usage = run.transcript ?? EMPTY_USAGE;
    return addUsage(acc, usage);
  }, { ...EMPTY_USAGE });
}

function sumJudgeUsage(runs: readonly SingleRunResult[]): TokenUsage {
  return runs.reduce<TokenUsage>(
    (acc, run) => addUsage(acc, run.judgeUsage),
    { ...EMPTY_USAGE },
  );
}

async function evaluateCase(
  client: BedrockClient,
  judgeClient: BedrockClient,
  testCase: EvalCase,
  defaultModelId: EvalSuite["defaultModelId"],
  capability: string,
  defaultSeverity: EvalSeverity,
  suiteTags: readonly string[],
  structuralOnly = false,
): Promise<CaseResult> {
  const debugIds = evalDebugIds(testCase, capability);
  const modelId = testCase.modelId ?? defaultModelId;
  const metadata = {
    severity: testCase.severity ?? defaultSeverity,
    tags: Array.from(new Set([...suiteTags, ...(testCase.tags ?? [])])).sort(),
  };

  if (structuralOnly) {
    // Mock mode proves harness wiring only; the fake client is deterministic,
    // so one run is representative and repeats would just burn time.
    let transcript: TurnTranscript & TokenUsage;
    try {
      transcript = await runTurn(client, testCase, defaultModelId);
    } catch (err) {
      return {
        caseId: testCase.id,
        description: testCase.description,
        ...metadata,
        modelId,
        ...debugIds,
        passed: false,
        assertions: [],
        answer: "",
        answerPreview: "",
        ...EMPTY_USAGE,
        toolCalls: [],
        toolResults: [],
        providerStatus: testCase.providerStatus,
        contextReceipts: testCase.contextReceipts ?? [],
        fixtureEvidence: testCase.fixtureEvidence ?? [],
        judgeUsage: { ...EMPTY_USAGE },
        errored: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      caseId: testCase.id,
      description: testCase.description,
      ...metadata,
      modelId,
      ...debugIds,
      passed: true,
      assertions: [
        {
          ok: true,
          label: "case executed; behavior assertions skipped in mock mode",
          detail: `${testCase.assertions.length} assertion(s) skipped`,
        },
      ],
      answer: transcript.answer,
      answerPreview: transcript.answer.slice(0, 280),
      tokensIn: transcript.tokensIn,
      tokensOut: transcript.tokensOut,
      inputTokens: transcript.inputTokens,
      cacheReadInputTokens: transcript.cacheReadInputTokens,
      cacheWriteInputTokens: transcript.cacheWriteInputTokens,
      toolCalls: transcript.toolCallNames,
      toolResults: summarizeToolResults(transcript.toolResults),
      providerStatus: transcript.providerStatus,
      contextReceipts: transcript.contextReceipts,
      fixtureEvidence: transcript.fixtureEvidence,
      judgeUsage: { ...EMPTY_USAGE },
    };
  }

  const repeat = Math.max(1, Math.floor(testCase.repeat ?? 1));
  const passPolicy = testCase.passPolicy ?? "all";

  const runs: SingleRunResult[] = [];
  for (let i = 0; i < repeat; i++) {
    runs.push(await runOnce(client, judgeClient, testCase, defaultModelId));
  }

  const passCount = runs.filter((run) => run.passed).length;
  const passed =
    passPolicy === "majority" ? passCount * 2 > repeat : passCount === repeat;

  // Debug should show a losing run: prefer the first error, then the first
  // failure. If the case passed overall, the first run is representative.
  const representative =
    (!passed && runs.find((run) => run.errored)) ||
    (!passed && runs.find((run) => !run.passed)) ||
    runs[0]!;
  const usage = sumUsage(runs);
  const judgeUsage = sumJudgeUsage(runs);
  const transcript = representative.transcript;
  const firstErrored = runs.find((run) => run.errored)?.errored;

  // Only surface repeat metadata for repeated cases so repeat=1 reports stay
  // byte-for-byte identical to the original single-sample format.
  const repeatMeta =
    repeat > 1 ? { runs: repeat, passCount, passPolicy } : {};

  const knownIssue = passed ? undefined : resolveKnownIssue(runs);

  return {
    caseId: testCase.id,
    description: testCase.description,
    ...metadata,
    ...(knownIssue ? { knownIssue } : {}),
    modelId,
    ...debugIds,
    passed,
    assertions: representative.assertions,
    answer: transcript?.answer ?? "",
    answerPreview: transcript?.answer.slice(0, 280) ?? "",
    ...usage,
    toolCalls: transcript?.toolCallNames ?? [],
    toolResults: transcript ? summarizeToolResults(transcript.toolResults) : [],
    providerStatus: testCase.providerStatus,
    contextReceipts: transcript?.contextReceipts ?? testCase.contextReceipts ?? [],
    fixtureEvidence: transcript?.fixtureEvidence ?? testCase.fixtureEvidence ?? [],
    judgeUsage,
    ...(representative.errored || (!passed && firstErrored)
      ? { errored: representative.errored ?? firstErrored }
      : {}),
    ...repeatMeta,
  };
}

export interface RunSuiteOptions {
  /** Override the model client (tests inject a fake). Defaults to real Bedrock. */
  client?: BedrockClient;
  /** Override the judge client. Defaults to the same real Bedrock client. */
  judgeClient?: BedrockClient;
  /**
   * Executes every case and captures reports without running behavioral
   * assertions. Used by `pnpm eval --mock`: the fake client proves harness
   * wiring only and should not fail because it cannot reason like a model.
   */
  structuralOnly?: boolean;
}

/** Run an entire capability suite and tally pass/fail. */
export async function runSuite(
  suite: EvalSuite,
  options: RunSuiteOptions = {},
): Promise<CapabilityResult> {
  const client = options.client ?? getBedrockClient();
  const judgeClient = options.judgeClient ?? client;

  const results: CaseResult[] = [];
  for (const testCase of suite.cases) {
    results.push(
      await evaluateCase(
        client,
        judgeClient,
        testCase,
        suite.defaultModelId,
        suite.capability,
        suite.defaultSeverity ?? "medium",
        suite.tags ?? [],
        options.structuralOnly,
      ),
    );
  }

  const severities: EvalSeverity[] = ["critical", "high", "medium", "low"];
  const bySeverity = Object.fromEntries(
    severities.map((severity) => {
      const matching = results.filter((result) => result.severity === severity);
      return [
        severity,
        {
          passed: matching.filter((result) => result.passed).length,
          failed: matching.filter((result) => !result.passed).length,
        },
      ];
    }),
  ) as CapabilityResult["bySeverity"];

  return {
    capability: suite.capability,
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    bySeverity,
  };
}

function evalDebugIds(
  testCase: EvalCase,
  capability: string,
): { threadId: string; runId: string } {
  const slug = `${capability}:${testCase.id}`.replace(/[^a-zA-Z0-9:_-]+/g, "-");
  return {
    threadId: testCase.threadId ?? `eval-thread:${slug}`,
    runId: testCase.runId ?? `eval-run:${slug}`,
  };
}
