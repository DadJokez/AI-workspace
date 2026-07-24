import { describe, expect, it } from "vitest";
import {
  resolveRuntimeModelSelection,
  selectAutopilotModel,
} from "@/lib/runtime-model-policy";

/** Temporary platform pin while the Sonnet 4.6 quota increase is pending. */
describe("selectAutopilotModel", () => {
  it("pins simple, writing, code, and long turns to Sonnet 4.5", () => {
    const messages = [
      "hey",
      "what time is it?",
      "draft an email to the facilities team",
      "```js\nfunction add(a,b){return a+b}\n```",
      "please " + "consider this carefully ".repeat(10),
    ];

    for (const message of messages) {
      expect(selectAutopilotModel(message)).toBe("sonnet-4-5");
    }
  });
});

describe("resolveRuntimeModelSelection with platform override", () => {
  const base = {
    route: { runtimeTarget: "direct-chat" as const },
    runtimeName: "bedrock" as const,
  };

  it("pins every autopilot ask and records the override reason", () => {
    const simple = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "default",
      directModelId: "auto",
      message: "hi",
    });
    expect(simple.modelId).toBe("sonnet-4-5");
    expect(simple.reason).toBe("platform_model_override");
    expect(simple.ignoredDirectModelId).toBe("auto");

    const writing = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "default",
      directModelId: "auto",
      message: "draft a memo summarizing the Q2 results",
    });
    expect(writing.modelId).toBe("sonnet-4-5");
    expect(writing.reason).toBe("platform_model_override");
  });

  it("supersedes a concrete configured model without rewriting it", () => {
    const pinned = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "default",
      directModelId: "haiku-4-5",
      message: "draft a long essay",
    });
    expect(pinned.modelId).toBe("sonnet-4-5");
    expect(pinned.reason).toBe("platform_model_override");
    expect(pinned.ignoredDirectModelId).toBe("haiku-4-5");
  });

  it("supersedes an explicit one-turn model override", () => {
    const pinned = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "haiku-4-5",
      directModelId: "auto",
      message: "draft a long leadership memo",
      forceRequestedModel: true,
    });
    expect(pinned.modelId).toBe("sonnet-4-5");
    expect(pinned.reason).toBe("platform_model_override");
    expect(pinned.ignoredDirectModelId).toBe("auto");
  });
});
