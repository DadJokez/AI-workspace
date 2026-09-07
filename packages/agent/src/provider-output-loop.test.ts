import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "./loop";
import { ToolRegistry } from "./registry";
import type { BedrockClient, BedrockStreamEvent, ConverseStreamParams } from "./clients";
import type { AgentEvent, AgentMessage } from "./types";
import { MODEL_IDS, type ModelId } from "./models";

function scripted(rounds: BedrockStreamEvent[][]) {
  const requests: ConverseStreamParams[] = [];
  const client: BedrockClient = {
    async *converseStream(params) {
      requests.push(structuredClone({ ...params, signal: undefined }));
      for (const event of rounds[requests.length - 1] ?? []) yield event;
    },
  };
  return { client, requests };
}
const history: AgentMessage[] = [
  { role: "assistant", content: "", toolCalls: [{ id: "old", name: "lookup", input: {} }] },
  { role: "tool", content: "", toolResults: [{ toolCallId: "old", output: "saved value" }] },
  { role: "user", content: "Summarize that value." },
];
async function drain(params: Parameters<typeof runAgentLoop>[0]) {
  const events: AgentEvent[] = [];
  for await (const event of runAgentLoop(params)) events.push(event);
  return events;
}
const call: BedrockStreamEvent = { type: "tool-use", id: "one", name: "lookup", input: {} };
const stop: BedrockStreamEvent = { type: "stop", reason: "tool_use" };

describe("provider compatibility at the shared loop", () => {
  it.each(MODEL_IDS)("keeps history config with no mounted tools: %s", async (modelId) => {
    const { client, requests } = scripted([[{ type: "text-delta", text: "  saved value" }]]);
    const events = await drain({ modelId, messages: history, registry: new ToolRegistry(), context: { userId: "u1" }, client });
    expect(requests[0]?.toolConfig?.tools[0]?.toolSpec.name).toBe("lookup");
    expect(events.filter(e => e.type === "text-delta")).toEqual([{ type: "text-delta", delta: "saved value" }]);
  });
  it("does not execute a registered historical tool outside the mounted allow-list", async () => {
    const handler = vi.fn(async () => "not allowed");
    const registry = new ToolRegistry();
    registry.register({ name: "lookup", description: "lookup", inputSchema: {}, policy: "always_allow", handler });
    const { client } = scripted([[call, stop]]);
    const events = await drain({ modelId: "kimi-k2-5", messages: history, registry, allowedTools: [], context: { userId: "u1" }, client });
    expect(handler).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "error", message: "Tool unavailable in this step: lookup" });
  });
  it("does not execute another tool during synthesis", async () => {
    const handler = vi.fn(async () => "saved");
    const registry = new ToolRegistry();
    registry.register({ name: "lookup", description: "lookup", inputSchema: {}, policy: "always_allow", handler });
    const { client, requests } = scripted([[call, stop], [call, stop]]);
    const events = await drain({ modelId: "kimi-k2-5", messages: [{ role: "user", content: "lookup" }], registry, maxToolIterations: 1, context: { userId: "u1" }, client });
    expect(requests[1]?.toolConfig).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
  it.each(["gpt-oss-120b", "deepseek-v3-2", "nova-pro"] as ModelId[])("cleans stream and continuation history: %s", async modelId => {
    const registry = new ToolRegistry();
    registry.register({ name: "lookup", description: "lookup", inputSchema: {}, policy: "always_allow", handler: async () => "saved" });
    const { client, requests } = scripted([
      [
        ...[..."<reasoning>private planning</reasoning>  Checking."].map(text => ({ type: "text-delta", text } as const)),
        call,
        stop,
      ],
      [{ type: "text-delta", text: "<thinking>private follow-up</thinking>  Final." }],
    ]);
    const events = await drain({ modelId, messages: [{ role: "user", content: "lookup" }], registry, context: { userId: "u1" }, client });
    const visible = events.filter(e => e.type === "text-delta").map(e => e.delta).join("");
    expect(visible).toBe("Checking.  Final.");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("private planning");
    expect(JSON.stringify(events)).not.toContain("private planning");
  });
  it("reports markup-only responses as errors, not a successful empty answer", async () => {
    const { client } = scripted([[{ type: "text-delta", text: "<thinking>unfinished" }]]);
    const events = await drain({ modelId: "gpt-oss-120b", messages: [{ role: "user", content: "hi" }], registry: new ToolRegistry(), context: { userId: "u1" }, client });
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some(e => e.type === "done")).toBe(false);
  });
});
