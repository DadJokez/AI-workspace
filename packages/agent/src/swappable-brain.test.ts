import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedrockRuntimeClient,
  type ConverseStreamCommand,
  type ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { RealBedrockClient } from "./clients";
import { runAgentLoop } from "./loop";
import { MODELS, isValidModelId, type ModelId, type ModelMetadata } from "./models";
import { ToolRegistry } from "./registry";
import type { AgentEvent } from "./types";

/**
 * #797 P1 exit test: a non-Anthropic Converse model that exists only as
 * registry metadata runs a full turn — tool round-trip included — through
 * the real Converse request builder with zero cache checkpoints, while an
 * Anthropic entry on the same path still gets them.
 *
 * The entry is test-only: it is injected into `MODELS` for this file and never
 * added to `MODEL_IDS`, so `isValidModelId` rejects it and the enablement
 * gate (`apps/web/lib/model-registry.ts`) cannot enable it for any purpose.
 */
const FAKE_ID = "test-nova-lite" as ModelId;
const FAKE_MODEL: ModelMetadata = {
  id: FAKE_ID,
  bedrockModelId: "us.amazon.nova-lite-v1:0",
  provider: "amazon",
  family: "nova",
  displayName: "Nova Lite",
  blurb: "Test-only non-Anthropic Converse entry (#797 P1).",
  costPer1MInput: 0.066,
  costPer1MOutput: 0.264,
  cacheReadInputMultiplier: 1,
  cacheWriteInputMultiplier: 1,
  supportsToolUse: true,
  supportsStreaming: true,
  supportsVision: false,
  supportsPromptCaching: false,
  invocation: "converse",
  contextWindow: 300_000,
  defaultMaxTokens: 5_000,
  recommendedFor: [],
};

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

describe("a non-Anthropic Converse registry entry runs a full turn (#797 P1)", () => {
  beforeAll(() => {
    (MODELS as Record<string, ModelMetadata>)[FAKE_ID] = FAKE_MODEL;
  });

  afterAll(() => {
    delete (MODELS as Record<string, ModelMetadata>)[FAKE_ID];
  });

  beforeEach(() => {
    vi.stubEnv("AWS_REGION", "us-east-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("is registered-but-unenablable: outside MODEL_IDS, so the enablement gate can never admit it", () => {
    expect(MODELS[FAKE_ID]).toBe(FAKE_MODEL);
    expect(isValidModelId(FAKE_ID)).toBe(false);
  });

  it("completes a tool round-trip with zero cache blocks in every Converse request", async () => {
    const { inputs, events } = await runFullTurn(FAKE_ID);

    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.modelId).toBe(FAKE_MODEL.bedrockModelId);
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
    const { events } = await runFullTurn(FAKE_ID);
    const requests = events.filter(
      (event): event is Extract<AgentEvent, { type: "provider-request" }> =>
        event.type === "provider-request",
    );
    expect(requests).toHaveLength(2);
    for (const event of requests) {
      expect(event.request.providerModelId).toBe(FAKE_MODEL.bedrockModelId);
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

  // The identity sentence in the stable prompt is owned by PR #798
  // (registry-derived "You are powered by <brandedName>, made by
  // <providerDisplayName>") and its single-sourcing by #856; this file must
  // not touch loop.ts identity code, so the truthful-identity half of the
  // P1 exit test activates with those.
  it.todo(
    'stamps a registry-derived identity line ("…Nova Lite, made by Amazon") into the stable prompt — lands with PR #798 / #856',
  );
});
