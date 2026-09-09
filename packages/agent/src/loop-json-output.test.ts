import { describe, expect, it } from "vitest";
import type { BedrockClient, BedrockStreamEvent } from "./clients";
import { runAgentLoop, MAX_TOKENS_TRUNCATION_NOTICE } from "./loop";
import { ToolRegistry } from "./registry";

async function output(request: string, chunks: string[], stop: "end_turn" | "max_tokens" = "end_turn") {
  const client: BedrockClient = {
    async *converseStream(): AsyncIterable<BedrockStreamEvent> {
      for (const text of chunks) yield { type: "text-delta", text };
      yield { type: "stop", reason: stop };
    },
  };
  const deltas: string[] = [];
  for await (const event of runAgentLoop({
    modelId: "sonnet-4-5", messages: [{ role: "user", content: request }],
    registry: new ToolRegistry(), context: { userId: "fixture" }, client,
  })) if (event.type === "text-delta") deltas.push(event.delta);
  return deltas;
}

describe("JSON-only output in the shared runtime", () => {
  it("does not release buffered text when cancellation arrives as the provider closes", async () => {
    const controller = new AbortController();
    const client: BedrockClient = {
      async *converseStream() {
        yield { type: "text-delta" as const, text: '```json\n{}\n```' };
        controller.abort();
      },
    };
    const events = [];
    for await (const event of runAgentLoop({
      modelId: "sonnet-4-5", messages: [{ role: "user", content: "Return only JSON." }],
      registry: new ToolRegistry(), context: { userId: "fixture" }, client,
      signal: controller.signal,
    })) events.push(event);
    expect(events.filter(event => event.type === "text-delta")).toEqual([]);
    expect(events).toContainEqual({ type: "error", message: "aborted" });
  });
  it("flushes preceding commentary before a tool call without editing it", async () => {
    const controller = new AbortController();
    const client: BedrockClient = {
      async *converseStream(): AsyncIterable<BedrockStreamEvent> {
        yield { type: "text-delta", text: "Checking the source." };
        yield { type: "tool-use", id: "call-1", name: "lookup", input: {} };
        controller.abort();
      },
    };
    const events = [];
    for await (const event of runAgentLoop({
      modelId: "sonnet-4-5", messages: [{ role: "user", content: "Return only JSON." }],
      registry: new ToolRegistry(), context: { userId: "fixture" }, client,
      signal: controller.signal,
    })) events.push(event);
    const visible = events.filter(event => event.type === "text-delta" || event.type === "tool-call");
    expect(visible).toEqual([
      { type: "text-delta", delta: "Checking the source." },
      { type: "tool-call", call: { id: "call-1", name: "lookup", input: {} } },
    ]);
  });
  it("emits one valid JSON answer even when fence markers span provider chunks", async () => {
    expect(await output("Return only a JSON object.", ["`", "``js", "on\n", '{"x":', '1}', "\n`", "``"]))
      .toEqual(['{"x":1}']);
  });
  it("retains explicit fenced output", async () => {
    const chunks = ["```json\n", '{"x":1}', "\n```"];
    expect(await output("Return only JSON in a code block.", chunks)).toEqual(chunks);
  });
  it("does not change malformed JSON or erase unrelated prose", async () => {
    for (const answer of ['```json\n{"x":}\n```', 'Here it is:\n```json\n{}\n```']) {
      expect((await output("Return only JSON.", [answer])).join("")).toBe(answer);
    }
  });
  it("preserves truncated output and the truncation notice", async () => {
    const answer = '```json\n{"x":1}\n```';
    expect((await output("Return only JSON.", [answer], "max_tokens")).join(""))
      .toBe(answer + MAX_TOKENS_TRUNCATION_NOTICE);
  });
  it("stops buffering oversized responses without losing or duplicating bytes", async () => {
    const chunks = ['```json\n{"text":"', "x".repeat(65_537), '"}\n```'];
    expect((await output("Return only JSON.", chunks)).join("")).toBe(chunks.join(""));
  });
});
