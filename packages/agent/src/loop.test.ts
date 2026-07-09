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

async function runTurn(client: BedrockClient, systemPrompt?: string) {
  const events = runAgentLoop({
    modelId: "sonnet-4-6",
    systemPrompt,
    messages: [{ role: "user", content: "hi" }],
    registry: new ToolRegistry(),
    context: { userId: "u1" },
    client,
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
