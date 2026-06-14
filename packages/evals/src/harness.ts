import {
  type AgentEvent,
  type BedrockClient,
  ToolRegistry,
  getBedrockClient,
  runAgentLoop,
} from "@ai-workspace/agent";
import type {
  AssertionResult,
  CapabilityResult,
  CaseResult,
  EvalCase,
  EvalSuite,
  TurnTranscript,
} from "./types";
import { runJudge } from "./judge";

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
): Promise<TurnTranscript & { tokensIn: number; tokensOut: number }> {
  const events: AgentEvent[] = [];
  let answer = "";
  let tokensIn = 0;
  let tokensOut = 0;
  const toolCallNames: string[] = [];

  for await (const ev of runAgentLoop({
    modelId: testCase.modelId ?? defaultModelId,
    systemPrompt: testCase.systemPrompt,
    messages: [{ role: "user", content: testCase.input }],
    registry: new ToolRegistry(),
    context: { userId: "eval" },
    client,
  })) {
    events.push(ev);
    if (ev.type === "text-delta") answer += ev.delta;
    else if (ev.type === "tool-call") toolCallNames.push(ev.call.name);
    else if (ev.type === "usage") {
      tokensIn = ev.tokensIn;
      tokensOut = ev.tokensOut;
    }
  }

  return { answer, events, toolCallNames, tokensIn, tokensOut };
}

async function evaluateCase(
  client: BedrockClient,
  judgeClient: BedrockClient,
  testCase: EvalCase,
  defaultModelId: EvalSuite["defaultModelId"],
  structuralOnly = false,
): Promise<CaseResult> {
  let transcript: TurnTranscript & { tokensIn: number; tokensOut: number };
  try {
    transcript = await runTurn(client, testCase, defaultModelId);
  } catch (err) {
    return {
      caseId: testCase.id,
      description: testCase.description,
      passed: false,
      assertions: [],
      answerPreview: "",
      tokensIn: 0,
      tokensOut: 0,
      errored: err instanceof Error ? err.message : String(err),
    };
  }

  if (structuralOnly) {
    return {
      caseId: testCase.id,
      description: testCase.description,
      passed: true,
      assertions: [
        {
          ok: true,
          label: "case executed; behavior assertions skipped in mock mode",
          detail: `${testCase.assertions.length} assertion(s) skipped`,
        },
      ],
      answerPreview: transcript.answer.slice(0, 280),
      tokensIn: transcript.tokensIn,
      tokensOut: transcript.tokensOut,
    };
  }

  const assertions: AssertionResult[] = [];
  for (const assertion of testCase.assertions) {
    if (assertion.kind === "deterministic") {
      const raw = assertion.check(transcript);
      const result = typeof raw === "boolean" ? { ok: raw } : raw;
      assertions.push({
        ok: result.ok,
        label: assertion.label,
        detail: result.detail,
      });
    } else {
      const verdict = await runJudge(judgeClient, {
        rubric: assertion.rubric,
        answer: transcript.answer,
      });
      assertions.push({
        ok: verdict.pass,
        label: assertion.label,
        detail: verdict.reason,
      });
    }
  }

  return {
    caseId: testCase.id,
    description: testCase.description,
    passed: assertions.every((a) => a.ok),
    assertions,
    answerPreview: transcript.answer.slice(0, 280),
    tokensIn: transcript.tokensIn,
    tokensOut: transcript.tokensOut,
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
        options.structuralOnly,
      ),
    );
  }

  return {
    capability: suite.capability,
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
  };
}
