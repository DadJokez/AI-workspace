import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  PLATFORM_MODEL_OVERRIDE_ID,
} from "@ai-workspace/agent";
import {
  resolveRuntimeModelSelection,
  selectAutopilotModel,
} from "@/lib/runtime-model-policy";

/**
 * While the account-wide pin is active it supersedes autopilot entirely. These
 * cases track the constant in `packages/agent/src/models.ts` rather than naming
 * a model version, so moving the pin stays a one-line change.
 */
const PINNED_MODEL_ID = PLATFORM_MODEL_OVERRIDE_ID ?? DEFAULT_MODEL_ID;

describe("selectAutopilotModel", () => {
  it("pins simple, writing, code, and long turns to the pinned platform model", () => {
    const messages = [
      "hey",
      "what time is it?",
      "draft an email to the facilities team",
      "```js\nfunction add(a,b){return a+b}\n```",
      "please " + "consider this carefully ".repeat(10),
    ];

    for (const message of messages) {
      expect(selectAutopilotModel(message)).toBe(PINNED_MODEL_ID);
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
    expect(simple.modelId).toBe(PINNED_MODEL_ID);
    expect(simple.reason).toBe("platform_model_override");
    expect(simple.ignoredDirectModelId).toBe("auto");

    const writing = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "default",
      directModelId: "auto",
      message: "draft a memo summarizing the Q2 results",
    });
    expect(writing.modelId).toBe(PINNED_MODEL_ID);
    expect(writing.reason).toBe("platform_model_override");
  });

  it("supersedes a concrete configured model without rewriting it", () => {
    const pinned = resolveRuntimeModelSelection({
      ...base,
      requestedModelId: "default",
      directModelId: "haiku-4-5",
      message: "draft a long essay",
    });
    expect(pinned.modelId).toBe(PINNED_MODEL_ID);
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
    expect(pinned.modelId).toBe(PINNED_MODEL_ID);
    expect(pinned.reason).toBe("platform_model_override");
    expect(pinned.ignoredDirectModelId).toBe("auto");
  });
});
