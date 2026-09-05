import { describe, expect, it } from "vitest";
import { MODELS } from "@ai-workspace/agent";
import {
  applyRuntimeModelFailover,
  resolveChatModelPreference,
  resolveModelFailoverChain,
  resolveRuntimeModelSelection,
} from "@/lib/runtime-model-policy";

const directRoute = { runtimeTarget: "direct-chat" as const };
const agentRoute = { runtimeTarget: "agentcore-worker" as const };

describe("resolveRuntimeModelSelection", () => {
  it("pins direct Bedrock chat to Sonnet 4.5", () => {
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "claude-sonnet-4-6",
        route: directRoute,
        runtimeName: "bedrock",
        directModelId: "haiku-4-5",
      }),
    ).toMatchObject({
      requestedModelId: "claude-sonnet-4-6",
      modelId: "sonnet-4-5",
      providerModelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      reason: "platform_model_override",
      ignoredDirectModelId: "haiku-4-5",
    });
  });

  it("pins model-decided and AgentCore turns to Sonnet 4.5", () => {
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
      modelId: "sonnet-4-5",
      providerModelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      reason: "platform_model_override",
      ignoredDirectModelId: "auto",
    });
    expect(
      resolveRuntimeModelSelection({
        requestedModelId: "claude-sonnet-4-6",
        route: agentRoute,
        runtimeName: "agentcore",
        directModelId: "haiku-4-5",
      }),
    ).toMatchObject({
      modelId: "sonnet-4-5",
      providerModelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
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
      modelId: "sonnet-4-5",
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
      modelId: "sonnet-4-5",
      providerModelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
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
        enabledModelIds: new Set(["haiku-4-5", "sonnet-4-6"]),
      }),
    ).toMatchObject({
      modelId: "sonnet-4-5",
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

describe("resolveModelFailoverChain (#797 P3)", () => {
  it("passes a same-provider chain through unchanged, whatever the qualified set says", () => {
    const chain = ["sonnet-4-6", "opus-4-7", "haiku-4-5"] as const;
    expect(resolveModelFailoverChain(chain, new Set())).toEqual([...chain]);
    expect(resolveModelFailoverChain(chain, new Set(["sonnet-4-6"]))).toEqual([
      ...chain,
    ]);
  });

  it("allows a cross-provider hop only onto a qualified model", () => {
    expect(MODELS["nova-pro"].provider).not.toBe(MODELS["sonnet-4-6"].provider);
    expect(
      resolveModelFailoverChain(
        ["sonnet-4-6", "nova-pro"],
        new Set(["sonnet-4-6", "nova-pro"]),
      ),
    ).toEqual(["sonnet-4-6", "nova-pro"]);
  });

  it("rejects a chain that would fail over into an unqualified provider", () => {
    expect(() =>
      resolveModelFailoverChain(["sonnet-4-6", "nova-pro"], new Set(["sonnet-4-6"])),
    ).toThrow(/crosses providers into "nova-pro" \(amazon\)/);
    // Symmetric: a Nova-first lane may not fall back onto unqualified Claude.
    expect(() =>
      resolveModelFailoverChain(["nova-pro", "haiku-4-5"], new Set(["nova-pro"])),
    ).toThrow(/crosses providers into "haiku-4-5" \(anthropic\)/);
  });

  it("checks every hop, not just the first", () => {
    expect(() =>
      resolveModelFailoverChain(
        ["sonnet-4-6", "haiku-4-5", "nova-pro"],
        new Set(["sonnet-4-6", "haiku-4-5"]),
      ),
    ).toThrow(/into "nova-pro"/);
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
