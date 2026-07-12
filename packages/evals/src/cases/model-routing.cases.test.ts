import { describe, expect, it } from "vitest";
import { ROUTING_BENCHMARK_TOOL_NAMES } from "../benchmarks/model-routing";
import {
  MODEL_ROUTING_FIXTURE_TOOLS,
  modelRoutingSuite,
} from "./model-routing.cases";

describe("model routing behavioral suite", () => {
  it("runs every routing case on Sonnet 4.6", () => {
    expect(modelRoutingSuite.defaultModelId).toBe("sonnet-4-6");
    expect(modelRoutingSuite.cases).toHaveLength(9);
    expect(
      modelRoutingSuite.cases.every(
        (testCase) => testCase.modelId === "sonnet-4-6",
      ),
    ).toBe(true);
  });

  it("uses the same stable full catalog as the benchmark", () => {
    expect(MODEL_ROUTING_FIXTURE_TOOLS.map((tool) => tool.name)).toEqual(
      ROUTING_BENCHMARK_TOOL_NAMES,
    );

    const fullCatalogCases = modelRoutingSuite.cases.filter(
      (testCase) => testCase.id !== "disconnected-calendar-stays-honest",
    );
    expect(
      fullCatalogCases.every(
        (testCase) =>
          testCase.tools?.length === ROUTING_BENCHMARK_TOOL_NAMES.length,
      ),
    ).toBe(true);
  });

  it("includes false-positive, provider-precedence, and multi-turn regressions", () => {
    expect(modelRoutingSuite.cases.map((testCase) => testCase.id)).toEqual(
      expect.arrayContaining([
        "natural-current-info-calls-web",
        "calendar-prefers-google",
        "new-mail-uses-gmail-and-evidence",
        "score-essay-does-not-search",
        "weekend-chitchat-does-not-search",
        "greeting-does-not-use-tools",
        "calendar-follow-up-keeps-provider-context",
        "disconnected-calendar-stays-honest",
      ]),
    );

    const followUp = modelRoutingSuite.cases.find(
      (testCase) =>
        testCase.id === "calendar-follow-up-keeps-provider-context",
    );
    expect(followUp?.messages?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(followUp?.messages?.at(-1)?.content).toBe("What about tomorrow?");
  });
});
