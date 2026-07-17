import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BedrockClient,
  BedrockStreamEvent,
  ConverseStreamParams,
} from "./clients";
import { MAX_TOKENS_TRUNCATION_NOTICE, runAgentLoop } from "./loop";
import { MODELS } from "./models";
import { ToolRegistry } from "./registry";

/** Records every ConverseStreamParams and replies with an empty turn. */
class CaptureClient implements BedrockClient {
  readonly captured: ConverseStreamParams[] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.captured.push(params);
    yield { type: "text-delta", text: "ok" };
    yield { type: "stop", reason: "end_turn" };
  }
}

async function runTurn(
  client: BedrockClient,
  systemPrompt?: string,
  temperature?: number,
) {
  const events = runAgentLoop({
    modelId: "sonnet-4-6",
    systemPrompt,
    messages: [{ role: "user", content: "hi" }],
    registry: new ToolRegistry(),
    context: { userId: "u1" },
    client,
    temperature,
  });
  for await (const _ev of events) {
    // drain
  }
}

describe("runAgentLoop system prompt caching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the cached system prefix byte-identical across turns at different times", async () => {
    const client = new CaptureClient();
    await runTurn(client, "You are the christmas checker.");

    // A later turn in the same conversation — wall clock has moved on.
    vi.setSystemTime(new Date("2026-07-09T09:41:23.456Z"));
    await runTurn(client, "You are the christmas checker.");

    expect(client.captured).toHaveLength(2);
    const [first, second] = client.captured;
    // The cached prefix must not change with the clock…
    expect(first?.systemPrompt).toBe(second?.systemPrompt);
    expect(first?.systemPrompt).not.toContain("Current date and time");
    // …while the clock still reaches the model, after the checkpoint.
    expect(first?.volatileSystemSuffix).toContain(
      "Current date and time (UTC): 2026-07-09T01:00:00.000Z",
    );
    expect(second?.volatileSystemSuffix).toContain(
      "Current date and time (UTC): 2026-07-09T09:41:23.456Z",
    );
  });

  it("stamps identity into the stable prompt and the clock into the suffix", async () => {
    const client = new CaptureClient();
    await runTurn(client);

    const params = client.captured[0];
    expect(params?.systemPrompt).toContain("You are Claude Sonnet 4.6");
    expect(params?.systemPrompt).toContain(
      "never claim to be an older model",
    );
    expect(params?.volatileSystemSuffix).toContain(
      "Treat this as ground truth for any date or time reasoning",
    );
  });

  it("composes the caller's volatile context ahead of the clock, off the cached prefix (#385)", async () => {
    const client = new CaptureClient();
    const events = runAgentLoop({
      modelId: "sonnet-4-6",
      systemPrompt: "You are the christmas checker.",
      volatileSystemSuffix: "Context receipt for this turn: 3 recent message(s).",
      messages: [{ role: "user", content: "hi" }],
      registry: new ToolRegistry(),
      context: { userId: "u1" },
      client,
    });
    for await (const _ev of events) {
      // drain
    }

    const params = client.captured[0];
    expect(params?.systemPrompt).not.toContain("Context receipt");
    const suffix = params?.volatileSystemSuffix ?? "";
    const receiptAt = suffix.indexOf("Context receipt for this turn");
    const clockAt = suffix.indexOf("Current date and time (UTC)");
    expect(receiptAt).toBeGreaterThanOrEqual(0);
    expect(clockAt).toBeGreaterThan(receiptAt);
  });

  it("forwards an explicit sampling temperature to the Bedrock seam", async () => {
    const client = new CaptureClient();
    await runTurn(client, undefined, 0);

    expect(client.captured[0]?.temperature).toBe(0);
  });
});

class UsageClient implements BedrockClient {
  async *converseStream(): AsyncIterable<BedrockStreamEvent> {
    yield { type: "text-delta", text: "ok" };
    yield {
      type: "usage",
      tokensIn: 1_050,
      tokensOut: 20,
      inputTokens: 100,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 50,
    };
    yield { type: "stop", reason: "end_turn" };
  }
}

describe("runAgentLoop usage telemetry", () => {
  it("preserves cache token components in the final usage event", async () => {
    const events = [];
    for await (const event of runAgentLoop({
      modelId: "sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      registry: new ToolRegistry(),
      context: { userId: "u1" },
      client: new UsageClient(),
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "usage",
      tokensIn: 1_050,
      tokensOut: 20,
      inputTokens: 100,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 50,
    });
  });
});

class RequiredToolClient implements BedrockClient {
  readonly captured: ConverseStreamParams[] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.captured.push(params);
    if (this.captured.length === 1) {
      yield {
        type: "tool-use",
        id: "required-call",
        name: "google__create_event",
        input: {},
      };
      yield { type: "stop", reason: "tool_use" };
      return;
    }
    yield { type: "text-delta", text: "Event created." };
    yield { type: "stop", reason: "end_turn" };
  }
}

describe("runAgentLoop required tools", () => {
  it("forces the required tool only on the first model step", async () => {
    const client = new RequiredToolClient();
    const registry = new ToolRegistry();
    registry.register({
      name: "google__create_event",
      description: "Create the signed, confirmed event.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      handler: async () => ({ created: true }),
    });

    const events = [];
    for await (const event of runAgentLoop({
      modelId: "haiku-4-5",
      messages: [{ role: "user", content: "confirm" }],
      registry,
      requiredToolName: "google__create_event",
      context: { userId: "u1" },
      client,
    })) {
      events.push(event);
    }

    expect(client.captured[0]?.toolConfig?.toolChoice).toEqual({
      tool: { name: "google__create_event" },
    });
    expect(client.captured[1]?.toolConfig?.toolChoice).toBeUndefined();
    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        toolCallId: "required-call",
        output: { created: true },
      },
    });
    expect(events).toContainEqual({ type: "done" });
  });

  it("fails closed before generation when the required tool is unavailable", async () => {
    const client = new CaptureClient();
    const events = [];
    for await (const event of runAgentLoop({
      modelId: "haiku-4-5",
      messages: [{ role: "user", content: "confirm" }],
      registry: new ToolRegistry(),
      requiredToolName: "google__create_event",
      context: { userId: "u1" },
      client,
    })) {
      events.push(event);
    }

    expect(client.captured).toHaveLength(0);
    expect(events).toEqual([
      {
        type: "error",
        message: "Required tool is unavailable: google__create_event",
      },
    ]);
  });
});

class ReasoningToolClient implements BedrockClient {
  readonly captured: ConverseStreamParams[] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.captured.push(params);
    if (this.captured.length === 1) {
      yield {
        type: "reasoning-text-delta",
        text: "I need the connected source.",
        blockIndex: 0,
      };
      yield {
        type: "reasoning-signature-delta",
        signature: "signed-reasoning",
        blockIndex: 0,
      };
      yield {
        type: "tool-use",
        id: "lookup-call",
        name: "lookup",
        input: { id: "42" },
        blockIndex: 1,
      };
      yield { type: "stop", reason: "tool_use" };
      yield { type: "metadata", latencyMs: 123 };
      return;
    }
    yield { type: "text-delta", text: "Found it." };
    yield { type: "stop", reason: "end_turn" };
  }
}

describe("runAgentLoop provider trace", () => {
  it("emits inspectable reasoning and preserves signed blocks for tool continuation", async () => {
    const client = new ReasoningToolClient();
    const registry = new ToolRegistry();
    registry.register({
      name: "lookup",
      description: "Look up a record.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
      },
      handler: async () => ({ title: "Answer" }),
    });

    const events = [];
    for await (const event of runAgentLoop({
      modelId: "sonnet-4-6",
      messages: [{ role: "user", content: "look it up" }],
      registry,
      context: { userId: "u1" },
      client,
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "provider-reasoning-delta",
      iteration: 0,
      blockIndex: 0,
      delta: "I need the connected source.",
    });
    expect(events).toContainEqual({
      type: "provider-response-metadata",
      iteration: 0,
      stopReason: "tool_use",
      additionalModelResponseFields: undefined,
    });
    expect(events).toContainEqual({
      type: "provider-response-metadata",
      iteration: 0,
      latencyMs: 123,
    });
    expect(client.captured[1]?.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          kind: "reasoning",
          text: "I need the connected source.",
          signature: "signed-reasoning",
        },
        {
          kind: "tool-use",
          id: "lookup-call",
          name: "lookup",
          input: { id: "42" },
        },
      ],
    });
  });
});

/**
 * Streams a long partial answer cut off mid-artifact — the #320 scenario: an
 * open ```html fence with no closing fence — then reports the output cap.
 */
class TruncatingClient implements BedrockClient {
  async *converseStream(
    _params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    yield {
      type: "text-delta",
      text: "Here you go:\n\n```html\n<!doctype html><html><head><style>.card {",
    };
    yield { type: "stop", reason: "max_tokens" };
  }
}

/** Truncates in the middle of plain prose — no code fence involved. */
class NoFenceTruncatingClient implements BedrockClient {
  async *converseStream(
    _params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    yield { type: "text-delta", text: "The three main causes were" };
    yield { type: "stop", reason: "max_tokens" };
  }
}

/** Fence markers (```) in a string, for asserting fences stay balanced. */
function countFenceMarkers(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

async function collectText(client: BedrockClient): Promise<string> {
  let text = "";
  const events = runAgentLoop({
    modelId: "sonnet-4-6",
    messages: [{ role: "user", content: "build me an app" }],
    registry: new ToolRegistry(),
    context: { userId: "u1" },
    client,
  });
  for await (const ev of events) {
    if (ev.type === "text-delta") text += ev.delta;
  }
  return text;
}

describe("runAgentLoop max_tokens truncation", () => {
  it("appends a visible truncation notice when the output cap cuts the response", async () => {
    const text = await collectText(new TruncatingClient());
    expect(text).toContain("<!doctype html>");
    expect(text.endsWith(MAX_TOKENS_TRUNCATION_NOTICE)).toBe(true);
  });

  it("closes a dangling code fence so the notice isn't swallowed by the artifact", async () => {
    const text = await collectText(new TruncatingClient());
    // The model left the ```html fence open; the notice would otherwise be
    // parsed as part of the (collapsed/persisted) artifact — the #320 honesty
    // failure. The loop must close the fence so markers stay balanced and the
    // notice lands after the closing fence, outside the code block.
    expect(countFenceMarkers(text) % 2).toBe(0);
    const closingFence = text.lastIndexOf("```");
    const notice = text.indexOf(MAX_TOKENS_TRUNCATION_NOTICE);
    expect(closingFence).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(closingFence);
  });

  it("does not inject a stray fence when the truncated text has no open fence", async () => {
    const text = await collectText(new NoFenceTruncatingClient());
    expect(text).not.toContain("```");
    expect(text.endsWith(MAX_TOKENS_TRUNCATION_NOTICE)).toBe(true);
  });

  it("does not add the notice on a normal end_turn", async () => {
    const text = await collectText(new CaptureClient());
    expect(text).toBe("ok");
    expect(text).not.toContain("output length limit");
  });
});

describe("model output caps", () => {
  it("gives every model enough output room for a complete artifact", () => {
    // 8192 truncated every HTML-app build mid-file (issue #320); keep the
    // floor high enough that a full artifact fits.
    for (const model of Object.values(MODELS)) {
      expect(model.defaultMaxTokens).toBeGreaterThanOrEqual(16_000);
    }
  });
});
