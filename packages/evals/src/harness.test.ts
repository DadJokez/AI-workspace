import { describe, expect, it } from "vitest";
import { FakeBedrockClient } from "@ai-workspace/agent";
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
});
