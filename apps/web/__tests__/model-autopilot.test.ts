import { describe, expect, it } from "vitest";
import {
  resolveRuntimeModelSelection,
  selectAutopilotModel,
} from "@/lib/runtime-model-policy";

/** #110 — server-side model autopilot. */
describe("selectAutopilotModel", () => {
  it("routes short/simple turns to Haiku", () => {
    expect(selectAutopilotModel("hey")).toBe("haiku-4-5");
    expect(selectAutopilotModel("what time is it?")).toBe("haiku-4-5");
    expect(selectAutopilotModel("thanks!")).toBe("haiku-4-5");
  });

  it("routes writing-grade asks to Sonnet", () => {
    expect(selectAutopilotModel("draft an email to the facilities team")).toBe(
      "sonnet-4-6",
    );
    expect(selectAutopilotModel("summarize this report for me")).toBe(
      "sonnet-4-6",
    );
    expect(
      selectAutopilotModel("write a polished status update for leadership"),
    ).toBe("sonnet-4-6");
    expect(selectAutopilotModel("analyze the pros and cons of option A")).toBe(
      "sonnet-4-6",
    );
  });

  it("routes code and long asks to Sonnet", () => {
    expect(
      selectAutopilotModel("```js\nfunction add(a,b){return a+b}\n```"),
    ).toBe("sonnet-4-6");
    const long = "please " + "consider this carefully ".repeat(10);
    expect(selectAutopilotModel(long)).toBe("sonnet-4-6");
  });

  it("biases to Sonnet for medium-length unsure turns", () => {
    expect(
      selectAutopilotModel("can you help me figure out the budget numbers here"),
    ).toBe("sonnet-4-6");
  });
});

describe("resolveRuntimeModelSelection with autopilot", () => {
  const base = {
    route: { runtimeTarget: "direct-chat" as const },
    runtimeName: "bedrock" as const,
  };

  it("picks per-ask when directModelId is 'auto'", () => {
    const simple = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "default",
      directModelId: "auto",
      message: "hi",
    });
    expect(simple.modelId).toBe("haiku-4-5");
    expect(simple.reason).toBe("runtime_v2_autopilot");

    const writing = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "default",
      directModelId: "auto",
      message: "draft a memo summarizing the Q2 results",
    });
    expect(writing.modelId).toBe("sonnet-4-6");
    expect(writing.reason).toBe("runtime_v2_autopilot");
  });

  it("still pins a concrete configured model (no behavior change when not 'auto')", () => {
    const pinned = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "default",
      directModelId: "haiku-4-5",
      message: "draft a long essay",
    });
    expect(pinned.modelId).toBe("haiku-4-5");
    expect(pinned.reason).toBe("runtime_v2_direct_model_config");
  });
});
