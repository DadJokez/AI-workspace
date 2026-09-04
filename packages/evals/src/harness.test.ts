import { describe, expect, it } from "vitest";
import {
  FakeBedrockClient,
  type BedrockClient,
  type ConverseStreamParams,
  type BedrockStreamEvent,
  type Tool,
} from "@ai-workspace/agent";
import { resolveKnownIssue, runSuite } from "./harness";
import type { EvalSuite } from "./types";

/**
 * Free, mock-mode wiring test (runs in normal CI). It does NOT validate model
 * behavior — the FakeBedrockClient echoes input — it proves the harness plumbs
 * cases → loop → assertions → tally correctly. The real-model suite
 * (`pnpm eval`) is what catches behavior bugs; it runs nightly with creds.
 */
const wiringSuite: EvalSuite = {
  capability: "wiring",
  defaultModelId: "haiku-4-5",
  cases: [
    {
      id: "deterministic-pass",
      description: "a deterministic assertion that should pass",
      input: "hello world",
      assertions: [
        {
          kind: "deterministic",
          label: "fake client echoes the input back",
          check: (t) => t.answer.includes("hello world"),
        },
      ],
    },
    {
      id: "deterministic-fail",
      description: "a deterministic assertion that should fail",
      input: "anything",
      assertions: [
        {
          kind: "deterministic",
          label: "impossible assertion",
          check: () => ({ ok: false, detail: "intentional" }),
        },
      ],
    },
  ],
};

class ToolCallingClient implements BedrockClient {
  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    const toolResult = params.messages
      .flatMap((message) => message.content)
      .find((block) => block.kind === "tool-result");
    const firstTool = params.toolConfig?.tools[0]?.toolSpec.name;

    if (!toolResult && firstTool) {
      yield {
        type: "tool-use",
        id: "fixture-call-1",
        name: firstTool,
        input: { limit: 3 },
      };
      yield {
        type: "usage",
        tokensIn: 8,
        tokensOut: 4,
        inputTokens: 8,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      };
      yield { type: "stop", reason: "tool_use" };
      return;
    }

    const reply =
      toolResult && toolResult.kind === "tool-result"
        ? `Used fixture evidence: ${toolResult.content}`
        : "No fixture evidence available.";
    yield { type: "text-delta", text: reply };
    yield {
      type: "usage",
      tokensIn: 12,
      tokensOut: 6,
      inputTokens: 12,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    yield { type: "stop", reason: "end_turn" };
  }
}

class PassingJudgeClient implements BedrockClient {
  prompts: string[] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.prompts.push(
      params.messages
        .flatMap((message) => message.content)
        .filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join("\n"),
    );
    yield { type: "text-delta", text: "PASS\nMatches reference evidence." };
    yield {
      type: "usage",
      tokensIn: 20,
      tokensOut: 5,
      inputTokens: 20,
      cacheReadInputTokens: 2,
      cacheWriteInputTokens: 1,
    };
    yield { type: "stop", reason: "end_turn" };
  }
}

class TokenBudgetClient implements BedrockClient {
  maxTokens: number[] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.maxTokens.push(params.maxTokens);
    yield { type: "text-delta", text: "ok" };
    yield {
      type: "usage",
      tokensIn: 1,
      tokensOut: 1,
      inputTokens: 1,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    yield { type: "stop", reason: "end_turn" };
  }
}

const fixtureTool: Tool = {
  name: "fixture__list_records",
  policy: "always_allow",
  description: "Return stable eval records.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "number" } },
  },
  handler: async () => ({ records: [{ id: 42, title: "Stable fixture fact" }] }),
};

describe("eval harness wiring", () => {
  it("runs cases through the loop and tallies pass/fail", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const result = await runSuite(wiringSuite, {
      client,
      judgeClient: client,
    });

    expect(result.capability).toBe("wiring");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);

    const pass = result.results.find((r) => r.caseId === "deterministic-pass");
    expect(pass?.passed).toBe(true);
    expect(pass).toMatchObject({
      threadId: "eval-thread:wiring:deterministic-pass",
      runId: "eval-run:wiring:deterministic-pass",
    });

    const fail = result.results.find((r) => r.caseId === "deterministic-fail");
    expect(fail?.passed).toBe(false);
    expect(fail?.assertions[0]?.detail).toBe("intentional");
  });

  it("captures token usage and an answer preview per case", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const result = await runSuite(wiringSuite, {
      client,
      judgeClient: client,
    });
    const first = result.results[0]!;
    expect(first.answerPreview.length).toBeGreaterThan(0);
    expect(first.inputTokens).toBeGreaterThan(0);
    expect(first.cacheReadInputTokens).toBe(0);
    expect(first.cacheWriteInputTokens).toBe(0);
    expect(first.tokensOut).toBeGreaterThan(0);
  });

  it("caps model output tokens for quota-efficient eval runs", async () => {
    const client = new TokenBudgetClient();
    await runSuite(wiringSuite, {
      client,
      judgeClient: client,
      structuralOnly: true,
    });

    expect(client.maxTokens).toEqual([4_096, 4_096]);
  });

  it("can run a structural-only mock pass without behavior assertions", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const result = await runSuite(wiringSuite, {
      client,
      judgeClient: client,
      structuralOnly: true,
    });

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results.map((r) => r.caseId)).toEqual([
      "deterministic-pass",
      "deterministic-fail",
    ]);
    expect(result.results[0]?.assertions[0]?.label).toContain(
      "behavior assertions skipped",
    );
  });

  it("mounts fixture tools and records report evidence", async () => {
    const suite: EvalSuite = {
      capability: "tool-fixture-wiring",
      defaultModelId: "haiku-4-5",
      cases: [
        {
          id: "fixture-tool-call",
          description: "fixture tool is mounted and reportable",
          input: "Use the fixture tool.",
          tools: [fixtureTool],
          providerStatus: { fixture: "mounted" },
          contextReceipts: ["provider:fixture mounted"],
          fixtureEvidence: ["Stable fixture fact"],
          assertions: [
            {
              kind: "deterministic",
              label: "fixture tool was called",
              check: (t) => t.toolCallNames.includes("fixture__list_records"),
            },
            {
              kind: "deterministic",
              label: "fixture output was captured",
              check: (t) =>
                JSON.stringify(t.toolResults).includes("Stable fixture fact"),
            },
          ],
        },
      ],
    };

    const result = await runSuite(suite, {
      client: new ToolCallingClient(),
      judgeClient: new FakeBedrockClient({ delayMs: 0 }),
    });

    expect(result.failed).toBe(0);
    const testCase = result.results[0]!;
    expect(testCase.toolCalls).toEqual(["fixture__list_records"]);
    expect(testCase.toolResults[0]?.outputPreview).toContain(
      "Stable fixture fact",
    );
    expect(testCase.providerStatus).toEqual({ fixture: "mounted" });
    expect(testCase.contextReceipts).toEqual(["provider:fixture mounted"]);
    expect(testCase.fixtureEvidence).toEqual(["Stable fixture fact"]);
  });

  it("runs unattended: a needs_approval fixture is denied, not paused (#701)", async () => {
    let handlerCalls = 0;
    const writeFixture: Tool = {
      name: "fixture__delete_records",
      policy: "needs_approval",
      description: "Delete eval records.",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
      handler: async () => {
        handlerCalls += 1;
        return { deleted: true };
      },
    };
    const suite: EvalSuite = {
      capability: "unattended-write-boundary",
      defaultModelId: "haiku-4-5",
      cases: [
        {
          id: "write-fixture-denied",
          description: "the harness denies the write and the turn continues",
          input: "Use the fixture tool.",
          tools: [writeFixture],
          assertions: [
            {
              kind: "deterministic",
              label: "write was requested but denied with a receipt",
              check: (t) => {
                const result = t.toolResults[0];
                return {
                  ok:
                    t.toolCallNames.includes("fixture__delete_records") &&
                    result?.isError === true &&
                    result?.policyDecision === "denied",
                  detail: JSON.stringify(result),
                };
              },
            },
            {
              kind: "deterministic",
              label: "the turn continued to a non-empty answer",
              check: (t) => t.answer.length > 0,
            },
            {
              kind: "deterministic",
              label: "no approval pause was emitted",
              check: (t) =>
                !t.events.some((e) => e.type === "tool-approval-required"),
            },
          ],
        },
      ],
    };

    const result = await runSuite(suite, {
      client: new ToolCallingClient(),
      judgeClient: new FakeBedrockClient({ delayMs: 0 }),
    });

    expect(handlerCalls).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results[0]?.assertions.map((a) => a.ok)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("preserves explicit app thread/run debug IDs for reports", async () => {
    const suite: EvalSuite = {
      capability: "debug-ids",
      defaultModelId: "haiku-4-5",
      cases: [
        {
          id: "failed-production-run",
          description: "explicit ids appear in failed eval reports",
          threadId: "thread-prod-1",
          runId: "run-prod-1",
          input: "anything",
          assertions: [
            {
              kind: "deterministic",
              label: "intentional failure",
              check: () => false,
            },
          ],
        },
      ],
    };

    const result = await runSuite(suite, {
      client: new FakeBedrockClient({ delayMs: 0 }),
      judgeClient: new FakeBedrockClient({ delayMs: 0 }),
    });

    expect(result.failed).toBe(1);
    expect(result.results[0]).toMatchObject({
      caseId: "failed-production-run",
      threadId: "thread-prod-1",
      runId: "run-prod-1",
    });
  });

  it("propagates stable severity/tags and accounts for judge usage", async () => {
    const suite: EvalSuite = {
      capability: "metadata-and-judge",
      defaultModelId: "haiku-4-5",
      defaultSeverity: "high",
      tags: ["core", "suite-tag"],
      cases: [
        {
          id: "critical-judge",
          description: "metadata and judge accounting",
          severity: "critical",
          tags: ["case-tag", "core"],
          input: "approved fact",
          repeat: 2,
          fixtureEvidence: ["case-level evidence"],
          assertions: [
            {
              kind: "judge",
              label: "calibrated judge",
              rubric: "Does the answer use the supplied evidence?",
              referenceEvidence: ["assertion-level evidence"],
            },
          ],
        },
      ],
    };
    const candidate = new FakeBedrockClient({ delayMs: 0 });
    const judge = new PassingJudgeClient();
    const result = await runSuite(suite, {
      client: candidate,
      judgeClient: judge,
    });

    expect(result.results[0]).toMatchObject({
      severity: "critical",
      tags: ["case-tag", "core", "suite-tag"],
      judgeUsage: {
        tokensIn: 40,
        tokensOut: 10,
        inputTokens: 40,
        cacheReadInputTokens: 4,
        cacheWriteInputTokens: 2,
      },
    });
    expect(result.bySeverity).toEqual({
      critical: { passed: 1, failed: 0 },
      high: { passed: 0, failed: 0 },
      medium: { passed: 0, failed: 0 },
      low: { passed: 0, failed: 0 },
    });
    expect(judge.prompts[0]).toContain("1. case-level evidence");
    expect(judge.prompts[0]).toContain("2. assertion-level evidence");
  });

  it("defaults to a single run and omits repeat metadata for repeat=1", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const result = await runSuite(wiringSuite, { client, judgeClient: client });
    const pass = result.results.find((r) => r.caseId === "deterministic-pass")!;
    expect(pass.runs).toBeUndefined();
    expect(pass.passCount).toBeUndefined();
    expect(pass.passPolicy).toBeUndefined();
  });

  function scriptedSuite(
    capability: string,
    outcomes: readonly boolean[],
    passPolicy: "all" | "majority",
  ): EvalSuite {
    let call = 0;
    return {
      capability,
      defaultModelId: "haiku-4-5",
      cases: [
        {
          id: "scripted",
          description: `${outcomes.length} runs, policy ${passPolicy}`,
          input: "hello world",
          repeat: outcomes.length,
          passPolicy,
          assertions: [
            {
              kind: "deterministic",
              label: "scripted per-run outcome",
              check: () => ({ ok: outcomes[call++] ?? true }),
            },
          ],
        },
      ],
    };
  }

  it("passPolicy 'all' fails the case if any single run fails", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const result = await runSuite(
      scriptedSuite("repeat-all", [true, true, false, true, true], "all"),
      { client, judgeClient: client },
    );
    const c = result.results[0]!;
    expect(c.runs).toBe(5);
    expect(c.passCount).toBe(4);
    expect(c.passPolicy).toBe("all");
    expect(c.passed).toBe(false);
    expect(result.failed).toBe(1);
    // Representative transcript is a losing run: its assertions show the failure.
    expect(c.assertions.some((a) => !a.ok)).toBe(true);
  });

  it("passPolicy 'all' passes only when every run passes", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const result = await runSuite(
      scriptedSuite("repeat-all-pass", [true, true, true], "all"),
      { client, judgeClient: client },
    );
    const c = result.results[0]!;
    expect(c.passCount).toBe(3);
    expect(c.passed).toBe(true);
  });

  it("passPolicy 'majority' passes on a strict majority and fails otherwise", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const pass = await runSuite(
      scriptedSuite("maj-pass", [true, false, true, false, true], "majority"),
      { client, judgeClient: client },
    );
    expect(pass.results[0]!.passCount).toBe(3);
    expect(pass.results[0]!.passed).toBe(true);

    const fail = await runSuite(
      scriptedSuite("maj-fail", [true, false, false, false, true], "majority"),
      { client, judgeClient: client },
    );
    expect(fail.results[0]!.passCount).toBe(2);
    expect(fail.results[0]!.passed).toBe(false);

    // A 1-of-2 tie is NOT a strict majority.
    const tie = await runSuite(
      scriptedSuite("maj-tie", [true, false], "majority"),
      { client, judgeClient: client },
    );
    expect(tie.results[0]!.passed).toBe(false);
  });

  it("sums token usage across repeated runs so cost accounting stays honest", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const base: EvalSuite = {
      capability: "usage-single",
      defaultModelId: "haiku-4-5",
      cases: [
        {
          id: "u",
          description: "single run baseline",
          input: "hello world",
          assertions: [
            { kind: "deterministic", label: "ok", check: () => true },
          ],
        },
      ],
    };
    const repeated: EvalSuite = {
      capability: "usage-repeat",
      defaultModelId: "haiku-4-5",
      cases: [{ ...base.cases[0]!, repeat: 3, passPolicy: "all" }],
    };
    const single = await runSuite(base, { client, judgeClient: client });
    const three = await runSuite(repeated, { client, judgeClient: client });
    const one = single.results[0]!;
    const many = three.results[0]!;
    expect(one.inputTokens).toBeGreaterThan(0);
    expect(many.inputTokens).toBe(one.inputTokens * 3);
    expect(many.tokensOut).toBe(one.tokensOut * 3);
  });

  it("passes optional multi-turn conversation history to the model", async () => {
    const suite: EvalSuite = {
      capability: "multi-turn-wiring",
      defaultModelId: "haiku-4-5",
      cases: [
        {
          id: "follow-up",
          description: "latest user follow-up is evaluated with prior context",
          input: "What about tomorrow?",
          messages: [
            { role: "user", content: "What is on my calendar today?" },
            { role: "assistant", content: "You have a staff sync." },
            { role: "user", content: "What about tomorrow?" },
          ],
          assertions: [
            {
              kind: "deterministic",
              label: "latest follow-up reached the client",
              check: (transcript) => transcript.answer.includes("What about tomorrow?"),
            },
          ],
        },
      ],
    };

    const client = new FakeBedrockClient({ delayMs: 0 });
    const result = await runSuite(suite, { client, judgeClient: client });

    expect(result.failed).toBe(0);
  });
});

describe("assertion-scoped known issues (#675)", () => {
  const passingAssertion = {
    kind: "deterministic" as const,
    label: "echoes input",
    check: (t: { answer: string }) => t.answer.length > 0,
  };
  const flakyFail = {
    kind: "deterministic" as const,
    label: "known-flaky guard",
    check: () => ({ ok: false, detail: "intentional flake" }),
    knownIssue: "#675",
  };
  const realFail = {
    kind: "deterministic" as const,
    label: "unmarked security guard",
    check: () => ({ ok: false, detail: "real regression" }),
  };

  it("propagates assertion knownIssue through runSuite onto the case result", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const suite: EvalSuite = {
      capability: "known-flaky",
      defaultModelId: "haiku-4-5",
      cases: [
        {
          id: "flaky-only",
          description: "only the marked assertion fails",
          input: "hello",
          assertions: [passingAssertion, flakyFail],
        },
      ],
    };
    const result = await runSuite(suite, { client, judgeClient: client });
    const c = result.results[0]!;
    expect(c.passed).toBe(false);
    expect(c.knownIssue).toBe("#675");
    expect(
      c.assertions.find((a) => a.label === "known-flaky guard")?.knownIssue,
    ).toBe("#675");
  });

  it("does not excuse a case when an unmarked assertion also fails", async () => {
    const client = new FakeBedrockClient({ delayMs: 0 });
    const suite: EvalSuite = {
      capability: "known-flaky",
      defaultModelId: "haiku-4-5",
      cases: [
        {
          id: "mixed-failure",
          description: "a real guard fails beside the marked flake",
          input: "hello",
          assertions: [flakyFail, realFail],
        },
      ],
    };
    const result = await runSuite(suite, { client, judgeClient: client });
    expect(result.results[0]!.passed).toBe(false);
    expect(result.results[0]!.knownIssue).toBeUndefined();
  });

  it("resolveKnownIssue excuses only wholly-known failures", () => {
    const known = { ok: false, label: "flake", knownIssue: "#675" };
    const unknown = { ok: false, label: "real" };
    const ok = { ok: true, label: "fine" };
    expect(
      resolveKnownIssue([{ assertions: [ok, known], passed: false }]),
    ).toBe("#675");
    expect(
      resolveKnownIssue([
        { assertions: [known], passed: false },
        { assertions: [unknown], passed: false },
      ]),
    ).toBeUndefined();
    expect(
      resolveKnownIssue([{ assertions: [ok], passed: true }]),
    ).toBeUndefined();
    expect(
      resolveKnownIssue([
        { assertions: [known], passed: false },
        { assertions: [], passed: false, errored: "bedrock throttled" },
      ]),
    ).toBeUndefined();
    expect(
      resolveKnownIssue([
        {
          assertions: [known, { ok: false, label: "other", knownIssue: "#123" }],
          passed: false,
        },
      ]),
    ).toBe("#123, #675");
  });
});
