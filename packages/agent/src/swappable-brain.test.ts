import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedrockRuntimeClient,
  type ConverseStreamCommand,
  type ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { RealBedrockClient } from "./clients";
import { runAgentLoop } from "./loop";
import {
  DEFAULT_MODEL_ID,
  MODELS,
  PLATFORM_MODEL_OVERRIDE_ID,
  isValidModelId,
  type ModelId,
} from "./models";
import { ToolRegistry } from "./registry";
import type { AgentEvent } from "./types";

/**
 * #797 exit test, now on the real first non-Claude brain (P3): the `nova-pro`
 * registry entry runs a full turn — tool round-trip included — through the
 * real Converse request builder with zero cache checkpoints and a truthful
 * registry-derived identity line, while an Anthropic entry on the same path
 * still gets its checkpoints. P1 proved this with a test-only fake entry
 * injected into `MODELS`; the real entry makes the same proof stronger
 * because it exercises the Bedrock id and capability flags production will
 * actually send.
 *
 * Enablement is not in this package: the entry has no `model_enablement`
 * rows, so it is disabled for every purpose (pinned in
 * `apps/web/__tests__/non-claude-brain.test.ts`).
 */
const NOVA: ModelId = "nova-pro";
/** Second non-Claude brain (#797): open-weight, ON_DEMAND, no `us.` profile. */
const GPT_OSS: ModelId = "gpt-oss-120b";

type StreamChunk = Record<string, unknown>;

/** First call answers with a tool call, second with text — a real two-hop turn. */
function stubTwoHopTurn() {
  const inputs: ConverseStreamCommandInput[] = [];
  vi.spyOn(
    BedrockRuntimeClient.prototype as unknown as {
      send: (
        command: ConverseStreamCommand,
      ) => Promise<{ stream: AsyncIterable<StreamChunk> }>;
    },
    "send",
  ).mockImplementation(async (command) => {
    inputs.push(command.input);
    const chunks: StreamChunk[] =
      inputs.length === 1
        ? [
            {
              contentBlockStart: {
                contentBlockIndex: 0,
                start: { toolUse: { toolUseId: "call-1", name: "echo__ping" } },
              },
            },
            {
              contentBlockDelta: {
                contentBlockIndex: 0,
                delta: { toolUse: { input: '{"text":"pong"}' } },
              },
            },
            { contentBlockStop: { contentBlockIndex: 0 } },
            { messageStop: { stopReason: "tool_use" } },
          ]
        : [
            {
              contentBlockDelta: {
                contentBlockIndex: 0,
                delta: { text: "The tool said pong." },
              },
            },
            { messageStop: { stopReason: "end_turn" } },
          ];
    return {
      stream: (async function* () {
        yield* chunks;
      })(),
    };
  });
  return inputs;
}

function registryWithPing(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo__ping",
    description: "Echo a string.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    policy: "always_allow",
    handler: async (input) => ({ echoed: (input as { text: string }).text }),
  });
  return registry;
}

async function runFullTurn(modelId: ModelId) {
  const inputs = stubTwoHopTurn();
  const events: AgentEvent[] = [];
  for await (const event of runAgentLoop({
    modelId,
    systemPrompt: "You are a concise assistant.",
    messages: [{ role: "user", content: "ping the tool" }],
    registry: registryWithPing(),
    context: { userId: "u1" },
    client: new RealBedrockClient(),
  })) {
    events.push(event);
  }
  return { inputs, events };
}

function countCachePoints(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((n, item) => n + countCachePoints(item), 0);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).reduce(
      (n, [key, item]) => n + (key === "cachePoint" ? 1 : 0) + countCachePoints(item),
      0,
    );
  }
  return 0;
}

describe("the real non-Claude Converse entry runs a full turn (#797 P1 exit test, P3 entry)", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_REGION", "us-east-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("is a real registry entry that no default or platform pin points at", () => {
    expect(isValidModelId(NOVA)).toBe(true);
    expect(DEFAULT_MODEL_ID).not.toBe(NOVA);
    expect(PLATFORM_MODEL_OVERRIDE_ID).not.toBe(NOVA);
    expect(MODELS[NOVA]).toMatchObject({
      bedrockModelId: "us.amazon.nova-pro-v1:0",
      provider: "amazon",
      family: "nova",
      invocation: "converse",
      supportsPromptCaching: false,
    });
    // Nova's documented output ceiling; the loop passes this straight to
    // Converse, so exceeding it would be a validation error on every turn.
    expect(MODELS[NOVA].defaultMaxTokens).toBeLessThanOrEqual(10_000);
  });

  it("completes a tool round-trip with zero cache blocks in every Converse request", async () => {
    const { inputs, events } = await runFullTurn(NOVA);

    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.modelId).toBe(MODELS[NOVA].bedrockModelId);
      expect(countCachePoints(input)).toBe(0);
    }
    // ADR 0010 layering is intact without the checkpoints: stable prompt
    // first, the per-turn clock after it.
    expect(inputs[0]?.system?.map((block) => "text" in block)).toEqual([true, true]);
    expect(inputs[0]?.system?.[0]).toMatchObject({
      text: expect.stringContaining("You are a concise assistant."),
    });
    expect(inputs[0]?.system?.[1]).toMatchObject({
      text: expect.stringContaining("Current date and time"),
    });
    expect(inputs[0]?.toolConfig?.tools).toHaveLength(1);
    expect(inputs[0]?.inferenceConfig?.maxTokens).toBe(MODELS[NOVA].defaultMaxTokens);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        call: expect.objectContaining({ name: "echo__ping" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        result: expect.objectContaining({ output: { echoed: "pong" } }),
      }),
    );
    expect(events).toContainEqual({ type: "text-delta", delta: "The tool said pong." });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("reports the registry's provider model id in the Run Inspector snapshot", async () => {
    const { events } = await runFullTurn(NOVA);
    const requests = events.filter(
      (event): event is Extract<AgentEvent, { type: "provider-request" }> =>
        event.type === "provider-request",
    );
    expect(requests).toHaveLength(2);
    for (const event of requests) {
      expect(event.request.providerModelId).toBe(MODELS[NOVA].bedrockModelId);
    }
  });

  it("still emits both checkpoints for an Anthropic entry on the same path (the gate is live)", async () => {
    const { inputs } = await runFullTurn("sonnet-4-6");

    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.system?.at(-2)).toEqual({ cachePoint: { type: "default" } });
      expect(input.toolConfig?.tools?.at(-1)).toEqual({
        cachePoint: { type: "default" },
      });
      expect(countCachePoints(input)).toBe(2);
    }
  });

  it('stamps a registry-derived identity line ("…Nova Pro, made by Amazon") into the stable prompt', async () => {
    // Exit criterion, second half: the cached stable prefix names the
    // registry vendor/brand, never a hardcoded Anthropic/Claude string.
    const { inputs } = await runFullTurn(NOVA);
    const system = (inputs[0]?.system ?? [])
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("\n");
    expect(system).toContain("You are powered by Nova Pro, made by Amazon.");
    expect(system).toContain('answer "Nova Pro"');
    // No `olderModelExample` on the entry → the neutral wording.
    expect(system).toContain(" or an older model version");
    expect(system).not.toMatch(/Anthropic|Claude/);
  });

  it("runs the OpenAI open-weight entry on the same path: bare on-demand id, no cache blocks, OpenAI identity line", async () => {
    expect(isValidModelId(GPT_OSS)).toBe(true);
    expect(DEFAULT_MODEL_ID).not.toBe(GPT_OSS);
    expect(PLATFORM_MODEL_OVERRIDE_ID).not.toBe(GPT_OSS);
    expect(MODELS[GPT_OSS]).toMatchObject({
      bedrockModelId: "openai.gpt-oss-120b-1:0",
      provider: "openai",
      family: "gpt-oss",
      invocation: "converse",
      supportsPromptCaching: false,
    });
    // No documented output ceiling below the 128k window; 32k was accepted
    // by Converse and clears the #320 artifact floor.
    expect(MODELS[GPT_OSS].defaultMaxTokens).toBeGreaterThanOrEqual(16_000);

    const { inputs, events } = await runFullTurn(GPT_OSS);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.modelId).toBe("openai.gpt-oss-120b-1:0");
      expect(countCachePoints(input)).toBe(0);
    }
    expect(inputs[0]?.inferenceConfig?.maxTokens).toBe(MODELS[GPT_OSS].defaultMaxTokens);
    expect(events).toContainEqual({ type: "text-delta", delta: "The tool said pong." });
    expect(events.at(-1)).toEqual({ type: "done" });

    const system = (inputs[0]?.system ?? [])
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("\n");
    expect(system).toContain("You are powered by GPT-OSS 120B, made by OpenAI.");
    expect(system).toContain('answer "GPT-OSS 120B"');
    expect(system).toContain(" or an older model version");
    expect(system).not.toMatch(/Anthropic|Claude|Amazon|Nova/);
  });
});
