import { MODELS, type ModelId } from "@ai-workspace/agent";
import { describe, expect, it } from "vitest";
import type { TurnTranscript } from "../types";
import {
  claimsNoOtherModel,
  modelIdentitySuite,
  namesServedModel,
  servedModel,
} from "./model-identity.cases";

function transcript(served: ModelId | null, answer: string): TurnTranscript {
  return {
    answer,
    events: served
      ? [
          {
            type: "provider-request",
            iteration: 0,
            request: {
              providerModelId: MODELS[served].bedrockModelId,
              messages: [],
              tools: [],
            },
          },
        ]
      : [],
    toolCallNames: [],
    toolResults: [],
    contextReceipts: [],
    fixtureEvidence: [],
  };
}

describe("model-identity suite (#797 P3)", () => {
  it("maps the Bedrock id the loop sent back to the registry entry", () => {
    expect(servedModel(transcript("nova-pro", ""))?.id).toBe("nova-pro");
    expect(servedModel(transcript("sonnet-4-5", ""))?.id).toBe("sonnet-4-5");
    expect(servedModel(transcript(null, ""))).toBeUndefined();
  });

  it.each([
    ["sonnet-4-5", "I'm Claude Sonnet 4.5, made by Anthropic."],
    ["sonnet-4-5", "I am Claude Sonnet 4.5 by Anthropic, served through Amazon Bedrock."],
    ["nova-pro", "I am Nova Pro, a model made by Amazon."],
    ["opus-4-7", "You're talking to Claude Opus 4.7 (Anthropic)."],
    // 2026-09-06 gaggle (#797 P5): the family word must appear as its own
    // token, so `qwen3` (not `qwen`) is the Qwen family.
    ["qwen3-next-80b", "I'm Qwen3 Next 80B, developed by Alibaba Cloud."],
    ["kimi-k2-5", "I am Kimi K2.5, made by Moonshot AI."],
    ["glm-5", "I'm GLM-5 from Z.ai."],
    ["deepseek-v3-2", "I am DeepSeek V3.2, made by DeepSeek."],
    ["sonnet-5", "I'm Claude Sonnet 5, made by Anthropic."],
  ] as const)("accepts a truthful answer on %s: %s", (served, answer) => {
    const t = transcript(served, answer);
    expect(namesServedModel(t)).toMatchObject({ ok: true });
    expect(claimsNoOtherModel(t)).toMatchObject({ ok: true });
  });

  it("fails a gaggle turn that names its sibling, and a Sonnet 4.5 turn is not confused with Sonnet 5", () => {
    const sibling = transcript("qwen3-next-80b", "I am Qwen3 32B, made by Alibaba Cloud.");
    expect(namesServedModel(sibling)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("missing: Qwen3 Next 80B"),
    });
    expect(claimsNoOtherModel(sibling)).toMatchObject({
      ok: false,
      detail: "also claims: Qwen3 32B",
    });
    // "Sonnet 4.5" must not read as a claim of "Sonnet 5" (or vice versa).
    const incumbent = transcript("sonnet-4-5", "I'm Claude Sonnet 4.5, made by Anthropic.");
    expect(claimsNoOtherModel(incumbent)).toMatchObject({ ok: true });
    const newer = transcript("sonnet-5", "I'm Claude Sonnet 5, made by Anthropic.");
    expect(claimsNoOtherModel(newer)).toMatchObject({ ok: true });
  });

  it("fails a Nova turn that introduces itself as Claude on both checks", () => {
    const t = transcript("nova-pro", "I am Claude Sonnet 4.5, made by Anthropic.");
    expect(namesServedModel(t)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("missing: nova, Nova Pro, Amazon"),
    });
    expect(claimsNoOtherModel(t)).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/also claims: .*Sonnet 4\.5/),
    });
    expect(claimsNoOtherModel(t).detail).toContain("claude");
  });

  it("fails a Claude turn that claims the known older version or a sibling model", () => {
    const older = transcript("sonnet-4-5", "I'm Claude 3.5 Sonnet by Anthropic.");
    expect(namesServedModel(older).ok).toBe(false);
    expect(claimsNoOtherModel(older)).toMatchObject({
      ok: false,
      detail: "also claims: Claude 3.5",
    });
    const sibling = transcript(
      "sonnet-4-5",
      "I'm Claude Sonnet 4.5 by Anthropic, the same model as Claude Sonnet 4.6.",
    );
    expect(namesServedModel(sibling).ok).toBe(true);
    expect(claimsNoOtherModel(sibling)).toMatchObject({
      ok: false,
      detail: "also claims: Sonnet 4.6",
    });
  });

  it("fails closed when no provider request reached a registry model", () => {
    const t = transcript(null, "I'm Claude Sonnet 4.5, made by Anthropic.");
    expect(namesServedModel(t).ok).toBe(false);
    expect(claimsNoOtherModel(t).ok).toBe(false);
  });

  it("is a critical, repeat-sampled core case with only run-time-derived assertions", () => {
    expect(modelIdentitySuite.defaultSeverity).toBe("critical");
    expect(modelIdentitySuite.tags).toContain("core");
    const [testCase] = modelIdentitySuite.cases;
    expect(testCase).toMatchObject({ repeat: 3, passPolicy: "all" });
    // Unpinned, so `--model` drives it and the nightly runs it on the default.
    expect(testCase?.modelId).toBeUndefined();
    expect(testCase?.assertions.every((a) => a.kind === "deterministic")).toBe(true);
  });
});
