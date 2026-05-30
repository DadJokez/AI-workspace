import { describe, expect, it } from "vitest";
import { normalizeRuntimeError } from "@/lib/runtime-errors";

const context = {
  runtime: "bedrock",
  runtimeTarget: "direct-chat",
  requestedModelId: "claude-sonnet-4-6",
  modelId: "sonnet-4-6",
  providerModelId: "us.anthropic.claude-sonnet-4-6",
};

describe("normalizeRuntimeError", () => {
  it("normalizes Bedrock marketplace/model access denial", () => {
    const result = normalizeRuntimeError(
      "Model access is denied due to IAM user or service role is not authorized to perform aws-marketplace:Subscribe.",
      context,
    );

    expect(result).toMatchObject({
      code: "bedrock_model_access_denied",
      category: "model_access_denied",
      retryable: false,
      metadata: context,
    });
    expect(result.userMessage).toContain("not enabled");
    expect(result.rawMessage).toContain("Model access is denied");
  });

  it("normalizes unavailable model identifiers", () => {
    expect(
      normalizeRuntimeError("BedrockRuntime: unknown modelId 'x'", context),
    ).toMatchObject({
      code: "provider_model_not_found",
      category: "model_not_found",
      retryable: false,
    });
  });

  it("keeps generic provider failures retryable", () => {
    expect(normalizeRuntimeError("temporary provider outage", context)).toMatchObject(
      {
        code: "provider_runtime_error",
        category: "provider_error",
        retryable: true,
        userMessage: "temporary provider outage",
      },
    );
  });
});
