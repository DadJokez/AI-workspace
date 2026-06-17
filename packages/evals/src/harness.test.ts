import { describe, expect, it } from "vitest";
import {
  FakeBedrockClient,
  type BedrockClient,
  type ConverseStreamParams,
  type BedrockStreamEvent,
  type Tool,
} from "@ai-workspace/agent";
import { runSuite } from "./harness";
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
      yield { type: "usage", tokensIn: 8, tokensOut: 4 };
      yield { type: "stop", reason: "tool_use" };
      return;
    }

    const reply =
      toolResult && toolResult.kind === "tool-result"
        ? `Used fixture evidence: ${toolResult.content}`
        : "No fixture evidence available.";
    yield { type: "text-delta", text: reply };
    yield { type: "usage", tokensIn: 12, tokensOut: 6 };
    yield { type: "stop", reason: "end_turn" };
  }
}

const fixtureTool: Tool = {
  name: "fixture__list_records",
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
    expect(first.tokensOut).toBeGreaterThan(0);
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
});
