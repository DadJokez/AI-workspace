import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  PLATFORM_MODEL_OVERRIDE_ID,
} from "@ai-workspace/agent";
import {
  applyRuntimeModelFailover,
  resolveChatModelPreference,
  resolveRuntimeModelSelection,
} from "@/lib/runtime-model-policy";

const directRoute = { runtimeTarget: "direct-chat" as const };
const agentRoute = { runtimeTarget: "agentcore-worker" as const };

/**
 * These cases assert that the account-wide pin wins, not that any particular
 * model version does, so they track the constant in
 * `packages/agent/src/models.ts` — moving the pin stays a one-line change.
 */
const PINNED_MODEL_ID = PLATFORM_MODEL_OVERRIDE_ID ?? DEFAULT_MODEL_ID;
const PINNED_PROVIDER_MODEL_ID = MODELS[PINNED_MODEL_ID].bedrockModelId;
/** Every registry model except the pin — the ids a pin has to supersede. */
const UNPINNED_MODEL_IDS = MODEL_IDS.filter((id) => id !== PINNED_MODEL_ID);

describe("resolveRuntimeModelSelection", () => {
  it("pins direct Bedrock chat to the pinned platform model", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "claude-opus-4-7",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: "haiku-4-5",
      }),
    ).toMatchObject({
      requestedModelId: "claude-opus-4-7",
      modelId: PINNED_MODEL_ID,
      providerModelId: PINNED_PROVIDER_MODEL_ID,
      reason: "platform_model_override",
      ignoredDirectModelId: "haiku-4-5",
    });
  });

  it("pins model-decided and AgentCore turns to the pinned platform model", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "haiku-4-5",
        route: {
          runtimeTarget: "bedrock-agent",
          routingMode: "model-decided",
        },
        runtimeName: "bedrock",
        directModelId: "auto",
        message: "hi",
      }),
    ).toMatchObject({
      modelId: PINNED_MODEL_ID,
      providerModelId: PINNED_PROVIDER_MODEL_ID,
      reason: "platform_model_override",
      ignoredDirectModelId: "auto",
    });
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "claude-opus-4-7",
        route: agentRoute,
        runtimeName: "agentcore",
        directModelId: "haiku-4-5",
      }),
    ).toMatchObject({
      modelId: PINNED_MODEL_ID,
      providerModelId: PINNED_PROVIDER_MODEL_ID,
      reason: "platform_model_override",
    });
  });

  it("supersedes explicit turn and provider-alias selections", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "opus-4-7",
        route: {
          runtimeTarget: "bedrock-agent",
          routingMode: "model-decided",
        },
        runtimeName: "bedrock",
        directModelId: "auto",
        forceRequestedModel: true,
      }),
    ).toMatchObject({
      modelId: PINNED_MODEL_ID,
      reason: "platform_model_override",
    });
  });

  it("pins unknown and stale saved model ids", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "not-a-real-model",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: "not-valid",
      }),
    ).toMatchObject({
      modelId: PINNED_MODEL_ID,
      providerModelId: PINNED_PROVIDER_MODEL_ID,
      reason: "platform_model_override",
      ignoredDirectModelId: "not-valid",
    });
  });

  it("supersedes stale enablement sets without mutating them", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "opus-4-7",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: undefined,
        forceRequestedModel: true,
        // The pin is absent from the enablement set and still wins.
        enabledModelIds: new Set(UNPINNED_MODEL_IDS),
      }),
    ).toMatchObject({
      modelId: PINNED_MODEL_ID,
      reason: "platform_model_override",
    });
  });
});

describe("resolveChatModelPreference", () => {
  it("gives an explicit user override priority over a skill pin", () => {
    expect(
      resolveChatModelPreference({
        requestedModelId: "opus-4-7",
        modelOverride: true,
        skillModelId: "haiku-4-5",
      }),
    ).toEqual({ modelId: "opus-4-7", source: "user_override" });
  });

  it("uses a skill pin ahead of the request default", () => {
    expect(
      resolveChatModelPreference({
        requestedModelId: "sonnet-4-6",
        modelOverride: false,
        skillModelId: "haiku-4-5",
      }),
    ).toEqual({ modelId: "haiku-4-5", source: "skill_pin" });
  });
});

describe("applyRuntimeModelFailover", () => {
  it("records the actual replacement model and provider", () => {
    const initial = resolveRuntimeModelSelection({
      requestedModelId: "sonnet-4-6",
      route: directRoute,
      runtimeName: "bedrock",
      directModelId: undefined,
    });

    expect(
      applyRuntimeModelFailover(initial, "haiku-4-5", "sonnet-4-5", 1),
    ).toMatchObject({
      requestedModelId: "sonnet-4-6",
      modelId: "haiku-4-5",
      providerModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      reason: "availability_failover",
      failover: {
        fromModelId: "sonnet-4-5",
        attempt: 1,
      },
    });
  });
});
