import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_IDS, MODELS, resolveBedrockModelId } from "./models";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveBedrockModelId", () => {
  it("returns every registry id unchanged when no prefix is configured", () => {
    vi.stubEnv("BEDROCK_INFERENCE_PROFILE_PREFIX", undefined);
    for (const id of MODEL_IDS) {
      expect(resolveBedrockModelId(MODELS[id].bedrockModelId)).toBe(
        MODELS[id].bedrockModelId,
      );
    }
  });

  it.each([
    ["us.", "us.anthropic.claude-sonnet-4-6"],
    ["eu.", "eu.anthropic.claude-sonnet-4-6"],
    ["global.", "global.anthropic.claude-sonnet-4-6"],
    ["", "anthropic.claude-sonnet-4-6"],
  ])("swaps the registry prefix for %j", (prefix, expected) => {
    expect(
      resolveBedrockModelId("us.anthropic.claude-sonnet-4-6", prefix),
    ).toBe(expected);
  });

  it("reads the prefix from the environment, including an empty one", () => {
    vi.stubEnv("BEDROCK_INFERENCE_PROFILE_PREFIX", "eu.");
    expect(resolveBedrockModelId("us.amazon.nova-pro-v1:0")).toBe(
      "eu.amazon.nova-pro-v1:0",
    );
    vi.stubEnv("BEDROCK_INFERENCE_PROFILE_PREFIX", "");
    expect(resolveBedrockModelId("us.amazon.nova-pro-v1:0")).toBe(
      "amazon.nova-pro-v1:0",
    );
  });

  it("leaves ids without a geo prefix alone", () => {
    expect(resolveBedrockModelId("openai.gpt-oss-120b-1:0", "eu.")).toBe(
      "openai.gpt-oss-120b-1:0",
    );
  });

  it("rejects an unknown prefix when called", () => {
    expect(() =>
      resolveBedrockModelId("us.anthropic.claude-sonnet-4-6", "apac."),
    ).toThrow(/BEDROCK_INFERENCE_PROFILE_PREFIX must be one of .*got "apac\."/);
    expect(() =>
      resolveBedrockModelId("openai.gpt-oss-120b-1:0", "us"),
    ).toThrow(/BEDROCK_INFERENCE_PROFILE_PREFIX/);
  });
});
