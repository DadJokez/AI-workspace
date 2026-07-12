import { describe, expect, it } from "vitest";
import { resolveRuntimeModelSelection } from "@/lib/runtime-model-policy";

const directRoute = { runtimeTarget: "direct-chat" as const };
const agentRoute = { runtimeTarget: "agentcore-worker" as const };

describe("resolveRuntimeModelSelection", () => {
  it("prefers the configured Runtime V2 direct model for Bedrock", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "claude-sonnet-4-6",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: "haiku-4-5",
      }),
    ).toMatchObject({
      requestedModelId: "claude-sonnet-4-6",
      modelId: "haiku-4-5",
      providerModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      reason: "runtime_v2_direct_model_config",
    });
  });

  it("maps provider-style Bedrock model aliases when no direct model is configured", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "claude-sonnet-4-6",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: undefined,
      }),
    ).toMatchObject({
      modelId: "sonnet-4-6",
      providerModelId: "us.anthropic.claude-sonnet-4-6",
      reason: "requested_model_alias",
    });
  });

  it("falls back to the product default when direct Bedrock cannot map the requested model", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "not-a-real-model",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: "not-valid",
      }),
    ).toMatchObject({
      modelId: "sonnet-4-6",
      providerModelId: "us.anthropic.claude-sonnet-4-6",
      reason: "default_model_fallback",
      ignoredDirectModelId: "not-valid",
    });
  });

  it("maps aliases for AgentCore worker routes", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "claude-sonnet-4-6",
        route: agentRoute,
        runtimeName: "agentcore",
        directModelId: "haiku-4-5",
      }),
    ).toMatchObject({
      modelId: "haiku-4-5",
      providerModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      reason: "runtime_v2_direct_model_config",
    });
  });

  it("never selects a model outside the enablement set, even when pinned", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "opus-4-7",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: undefined,
        forceRequestedModel: true,
        enabledModelIds: new Set(["haiku-4-5", "sonnet-4-6"]),
      }),
    ).toMatchObject({
      modelId: "sonnet-4-6",
      reason: "default_model_fallback",
    });
  });

  it("skips a disabled configured direct model", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "not-a-real-model",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: "opus-4-7",
        enabledModelIds: new Set(["haiku-4-5"]),
      }),
    ).toMatchObject({
      modelId: "haiku-4-5",
      reason: "default_model_fallback",
    });
  });

  it("reroutes an autopilot pick that lands on a disabled model", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "auto",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: "auto",
        message: "hi there",
        enabledModelIds: new Set(["sonnet-4-6"]),
      }),
    ).toMatchObject({
      // "hi there" would pick Haiku; Haiku is disabled for this lane.
      modelId: "sonnet-4-6",
      reason: "runtime_v2_autopilot",
    });
  });

  it("keeps allowed selections identical when an enablement set is provided", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "opus-4-7",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: undefined,
        forceRequestedModel: true,
        enabledModelIds: new Set(["haiku-4-5", "sonnet-4-6", "opus-4-7"]),
      }),
    ).toMatchObject({
      modelId: "opus-4-7",
      reason: "requested_model_supported",
    });
  });
});
