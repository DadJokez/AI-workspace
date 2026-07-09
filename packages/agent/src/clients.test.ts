import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedrockRuntimeClient,
  type ConverseStreamCommand,
  type ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  RealBedrockClient,
  toAwsToolConfiguration,
  type BedrockStreamEvent,
} from "./clients";
import type { BedrockToolConfig } from "./registry";

/** Loose chunk shape so tests can feed exactly the fields the client reads. */
type StreamChunk = Record<string, unknown>;

/**
 * Stubs `BedrockRuntimeClient.send`, capturing each command's input and
 * replaying the given chunks as the response stream.
 */
function stubSend(chunks: StreamChunk[] = []) {
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
    return {
      stream: (async function* () {
        yield* chunks;
      })(),
    };
  });
  return inputs;
}

async function collect(
  iter: AsyncIterable<BedrockStreamEvent>,
): Promise<BedrockStreamEvent[]> {
  const events: BedrockStreamEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

const TOOL_CONFIG: BedrockToolConfig = {
  tools: [
    {
      toolSpec: {
        name: "top_song",
        description: "Get the most popular song on a station.",
        inputSchema: { json: { type: "object", properties: {} } },
      },
    },
  ],
};

describe("toAwsToolConfiguration", () => {
  it("returns undefined when no tool config is given", () => {
    expect(toAwsToolConfiguration(undefined)).toBeUndefined();
  });

  it("appends a cachePoint after the tool definitions", () => {
    const cfg = toAwsToolConfiguration(TOOL_CONFIG);
    expect(cfg?.tools).toHaveLength(2);
    expect(cfg?.tools?.[0]).toMatchObject({
      toolSpec: { name: "top_song" },
    });
    expect(cfg?.tools?.[1]).toEqual({ cachePoint: { type: "default" } });
  });
});

describe("RealBedrockClient prompt caching", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_REGION", "us-east-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("places a cachePoint after the system prompt", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.system).toEqual([
      { text: "You are a helpful assistant." },
      { cachePoint: { type: "default" } },
    ]);
  });

  it("renders the volatile suffix after the cache checkpoint", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        systemPrompt: "You are a helpful assistant.",
        volatileSystemSuffix: "Current date and time (UTC): 2026-07-09T01:00:00.000Z.",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(inputs[0]?.system).toEqual([
      { text: "You are a helpful assistant." },
      { cachePoint: { type: "default" } },
      { text: "Current date and time (UTC): 2026-07-09T01:00:00.000Z." },
    ]);
  });

  it("sends a volatile-only system without a cachePoint", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        volatileSystemSuffix: "Current date and time (UTC): 2026-07-09T01:00:00.000Z.",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(inputs[0]?.system).toEqual([
      { text: "Current date and time (UTC): 2026-07-09T01:00:00.000Z." },
    ]);
  });

  it("omits system entirely (no orphan cachePoint) without a system prompt", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(inputs[0]?.system).toBeUndefined();
    expect(inputs[0]?.toolConfig).toBeUndefined();
  });

  it("sends the tool cachePoint through the Converse command", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        systemPrompt: "s",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        toolConfig: TOOL_CONFIG,
        maxTokens: 100,
      }),
    );

    const tools = inputs[0]?.toolConfig?.tools;
    expect(tools?.at(-1)).toEqual({ cachePoint: { type: "default" } });
    // Messages carry no cachePoint — only system and tools are cached.
    expect(inputs[0]?.messages).toEqual([
      { role: "user", content: [{ text: "hi" }] },
    ]);
  });

  it("counts cache reads and writes in tokensIn", async () => {
    stubSend([
      {
        metadata: {
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheReadInputTokens: 900,
            cacheWriteInputTokens: 50,
          },
        },
      },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    const client = new RealBedrockClient();
    const events = await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(events).toContainEqual({
      type: "usage",
      tokensIn: 1050,
      tokensOut: 20,
    });
  });

  it("reports plain inputTokens when the response has no cache fields", async () => {
    stubSend([
      { metadata: { usage: { inputTokens: 42, outputTokens: 7 } } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    const client = new RealBedrockClient();
    const events = await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(events).toContainEqual({
      type: "usage",
      tokensIn: 42,
      tokensOut: 7,
    });
  });
});
