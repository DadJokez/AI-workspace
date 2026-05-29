import { describe, expect, it } from "vitest";
import { resolveRuntimeModelSelection } from "@/lib/runtime-model-policy";

const directRoute = { runtimeTarget: "direct-chat" as const };
const agentRoute = { runtimeTarget: "cursor-agent" as const };

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

  it("maps Cursor-facing direct Bedrock model aliases when no direct model is configured", () => {
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

  it("passes model ids through for Cursor agent routes", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "claude-sonnet-4-6",
        route: agentRoute,
        runtimeName: "cursor",
        directModelId: "haiku-4-5",
      }),
    ).toMatchObject({
      modelId: "claude-sonnet-4-6",
      providerModelId: "claude-sonnet-4-6",
      reason: "runtime_passthrough",
    });
  });
});
