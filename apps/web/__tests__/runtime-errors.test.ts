import { describe, expect, it } from "vitest";
import { normalizeRuntimeError } from "@/lib/runtime-errors";

const context = {
  runtime: "bedrock",
  runtimeTarget: "direct-chat",
  requestedModelId: "claude-sonnet-4-6",
  modelId: "sonnet-4-6",
  providerModelId: "us.anthropic.claude-sonnet-4-6",
};

const agentCoreContext = {
  runtime: "agentcore",
  runtimeTarget: "agentcore-worker",
  requestedModelId: "sonnet-4-6",
  modelId: "sonnet-4-6",
};

describe("normalizeRuntimeError", () => {
  it("classifies the production AgentCore IAM denial without blaming model access", () => {
    const deniedAction = "bedrock-agentcore:InvokeAgentRuntimeForUser";
    const deniedResource =
      "arn:aws:bedrock-agentcore:us-east-1:351478076796:runtime/comparative";
    const result = normalizeRuntimeError(
      `AccessDeniedException: User arn:aws:sts::351478076796:assumed-role/chat-worker/session is not authorized to perform: ${deniedAction} on resource: ${deniedResource} because no identity-based policy allows the action.`,
      agentCoreContext,
    );

    expect(result).toMatchObject({
      code: "agentcore_invoke_access_denied",
      category: "runtime_authorization_denied",
      retryable: false,
      metadata: {
        ...agentCoreContext,
        deniedAction,
        deniedResource,
      },
    });
    expect(result.userMessage).toContain("workspace runtime");
    expect(result.userMessage).not.toContain("model");
    expect(result.userMessage).not.toContain("arn:aws");
    expect(result.rawMessage).toContain(deniedAction);
    expect(result.rawMessage).toContain(deniedResource);
  });

  it("classifies a generic AgentCore AccessDenied using runtime context", () => {
    expect(
      normalizeRuntimeError(
        "AgentCoreRuntime: invoke failed — AccessDeniedException: Access denied",
        agentCoreContext,
      ),
    ).toMatchObject({
      code: "agentcore_invoke_access_denied",
      category: "runtime_authorization_denied",
      retryable: false,
      metadata: agentCoreContext,
    });
  });

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

  it("keeps a genuine Bedrock InvokeModel denial in the model-access category", () => {
    const result = normalizeRuntimeError(
      "AccessDeniedException: User is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1::foundation-model/us.anthropic.claude-sonnet-4-6.",
      context,
    );

    expect(result).toMatchObject({
      code: "bedrock_model_access_denied",
      category: "model_access_denied",
      retryable: false,
      metadata: {
        ...context,
        deniedAction: "bedrock:InvokeModel",
        deniedResource:
          "arn:aws:bedrock:us-east-1::foundation-model/us.anthropic.claude-sonnet-4-6",
      },
    });
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
