import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
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
 * #797 P4 exit test (#660): the `gpt-5-6-terra` entry runs a full turn —
 * tool round-trip included — through the production path (`runAgentLoop` →
 * `RealBedrockClient` → `BedrockResponsesClient` → SigV4-signed HTTPS) with
 * `store: false` on every request, zero cache markers, and a truthful
 * registry-derived identity line; a Claude entry on the same client object
 * still goes to Converse. The transport is stubbed at `fetch`; the signer
 * and credential chain are real (static env credentials).
 */
const TERRA: ModelId = "gpt-5-6-terra";
const RESPONSES_URL =
  "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses";

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

/** First call answers with a function call, second with text — a real two-hop turn. */
function stubTwoHopResponses() {
  const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    const stream =
      requests.length === 1
        ? sse([
            {
              event: "response.output_item.added",
              data: { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "echo__ping", arguments: "" } },
            },
            { event: "response.function_call_arguments.delta", data: { output_index: 0, delta: '{"text":"pong"}' } },
            {
              event: "response.output_item.done",
              data: { output_index: 0, item: { type: "function_call", call_id: "call_1", name: "echo__ping", arguments: '{"text":"pong"}' } },
            },
            { event: "response.completed", data: { response: { id: "resp_1", status: "completed", usage: { input_tokens: 50, output_tokens: 8 } } } },
          ])
        : sse([
            { event: "response.output_text.delta", data: { output_index: 0, delta: "The tool said pong." } },
            { event: "response.completed", data: { response: { id: "resp_2", status: "completed", usage: { input_tokens: 70, output_tokens: 6 } } } },
          ]);
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
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

async function runFullTurn(modelId: ModelId, client = new RealBedrockClient()) {
  const events: AgentEvent[] = [];
  for await (const event of runAgentLoop({
    modelId,
    systemPrompt: "You are a concise assistant.",
    messages: [{ role: "user", content: "ping the tool" }],
    registry: registryWithPing(),
    context: { userId: "u1" },
    client,
  })) {
    events.push(event);
  }
  return events;
}

describe("the GPT-5.6 Terra entry runs a full turn through the Responses route (#797 P4 exit test)", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIATEST");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is a real responses-route registry entry that no default or platform pin points at", () => {
    expect(isValidModelId(TERRA)).toBe(true);
    expect(DEFAULT_MODEL_ID).not.toBe(TERRA);
    expect(PLATFORM_MODEL_OVERRIDE_ID).not.toBe(TERRA);
    expect(MODELS[TERRA]).toMatchObject({
      bedrockModelId: "us.openai.gpt-5.6-terra",
      provider: "openai",
      family: "gpt",
      providerDisplayName: "OpenAI",
      invocation: "responses",
      supportsPromptCaching: false,
    });
  });

  it("completes a tool round-trip with store:false, SigV4 auth and zero cache markers on every request", async () => {
    const requests = stubTwoHopResponses();
    const events = await runFullTurn(TERRA);

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(RESPONSES_URL);
      expect(request.body).toMatchObject({
        model: MODELS[TERRA].bedrockModelId,
        store: false,
        stream: true,
        max_output_tokens: MODELS[TERRA].defaultMaxTokens,
      });
      expect(JSON.stringify(request.body)).not.toMatch(/cachePoint|cache_control|previous_response_id/);
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
      expect(request.headers.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    }
    // ADR 0010 layering survives the fold: stable prompt first, clock after.
    const instructions = String(requests[0]!.body.instructions);
    expect(instructions.indexOf("You are a concise assistant.")).toBeLessThan(
      instructions.indexOf("Current date and time"),
    );
    expect(requests[0]!.body.tools).toEqual([
      expect.objectContaining({ type: "function", name: "echo__ping", strict: false }),
    ]);
    // The second request replays the call and its result by call id.
    expect(requests[1]!.body.input).toEqual(
      expect.arrayContaining([
        { type: "function_call", call_id: "call_1", name: "echo__ping", arguments: '{"text":"pong"}' },
        { type: "function_call_output", call_id: "call_1", output: '{"echoed":"pong"}' },
      ]),
    );

    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-call", call: expect.objectContaining({ id: "call_1", name: "echo__ping" }) }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool-result", result: expect.objectContaining({ output: { echoed: "pong" } }) }),
    );
    expect(events).toContainEqual({ type: "text-delta", delta: "The tool said pong." });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage",
        tokensIn: 120,
        tokensOut: 14,
        inputTokens: 120,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      }),
    );
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("identifies the endpoint and provider model id in Run Inspector events without leaking content", async () => {
    stubTwoHopResponses();
    const events = await runFullTurn(TERRA);
    const requests = events.filter(
      (event): event is Extract<AgentEvent, { type: "provider-request" }> => event.type === "provider-request",
    );
    expect(requests).toHaveLength(2);
    for (const event of requests) {
      expect(event.request.providerModelId).toBe("us.openai.gpt-5.6-terra");
    }
    const stops = events.filter(
      (event): event is Extract<AgentEvent, { type: "provider-response-metadata" }> =>
        event.type === "provider-response-metadata" && event.stopReason !== undefined,
    );
    expect(stops.map((event) => event.stopReason)).toEqual(["tool_use", "end_turn"]);
    expect(stops[0]!.additionalModelResponseFields).toEqual({
      endpoint: "bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses",
      responseId: "resp_1",
      status: "completed",
    });
  });

  it('stamps a registry-derived identity line ("…GPT-5.6 Terra, made by OpenAI") into the instructions', async () => {
    const requests = stubTwoHopResponses();
    await runFullTurn(TERRA);
    const instructions = String(requests[0]!.body.instructions);
    expect(instructions).toContain("You are powered by GPT-5.6 Terra, made by OpenAI.");
    expect(instructions).toContain('answer "GPT-5.6 Terra"');
    expect(instructions).toContain('an older model such as "GPT-4"');
    expect(instructions).not.toMatch(/Anthropic|Claude/);
  });

  it("still sends a Claude entry on the same client to Converse, untouched", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const send = vi
      .spyOn(BedrockRuntimeClient.prototype as unknown as { send: (command: unknown) => Promise<unknown> }, "send")
      .mockResolvedValue({
        stream: (async function* () {
          yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hi" } } };
          yield { messageStop: { stopReason: "end_turn" } };
        })(),
      });
    const client = new RealBedrockClient();
    const events = await runFullTurn("sonnet-4-6", client);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "text-delta", delta: "hi" });
  });
});
