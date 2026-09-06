import { describe, expect, it, vi } from "vitest";
import type { BedrockStreamEvent, ConverseStreamParams } from "./clients";
import {
  BedrockResponsesClient,
  RESPONSES_API_PATH,
  ResponsesStreamTranslator,
  buildResponsesRequest,
  parseServerSentEvents,
} from "./responses-client";

const BASE: ConverseStreamParams = {
  bedrockModelId: "us.openai.gpt-5.6-terra",
  supportsPromptCaching: false,
  invocation: "responses",
  systemPrompt: "Stable prompt.",
  volatileSystemSuffix: "Clock line.",
  messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
  maxTokens: 1234,
};

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
}

function streamOf(text: string, chunk = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("buildResponsesRequest", () => {
  it("folds the stable prompt and volatile suffix into instructions, sends store:false and stream:true", () => {
    const request = buildResponsesRequest(BASE);
    expect(request).toEqual({
      model: "us.openai.gpt-5.6-terra",
      instructions: "Stable prompt.\n\nClock line.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_output_tokens: 1234,
      stream: true,
      store: false,
    });
    // No temperature unless the loop asked for one (GPT reasoning models
    // reject anything but the default), and never a cache marker.
    expect(request).not.toHaveProperty("temperature");
    expect(JSON.stringify(request)).not.toMatch(/cachePoint|cache_control/);
  });

  it("maps a tool round-trip losslessly: function tools (strict:false), forced tool_choice, function_call + function_call_output by call id", () => {
    const request = buildResponsesRequest({
      ...BASE,
      temperature: 0,
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "echo__ping",
              description: "Echo.",
              inputSchema: { json: { type: "object", properties: { text: { type: "string" } } } },
            },
          },
        ],
        toolChoice: { tool: { name: "echo__ping" } },
      },
      messages: [
        {
          role: "user",
          content: [
            { kind: "text", text: "ping" },
            { kind: "image", format: "png", dataBase64: "AAAA" },
          ],
        },
        {
          role: "assistant",
          content: [
            { kind: "reasoning", text: "private", signature: "sig" },
            { kind: "text", text: "Calling the tool." },
            { kind: "tool-use", id: "call_1", name: "echo__ping", input: { text: "pong" } },
          ],
        },
        {
          role: "user",
          content: [
            { kind: "tool-result", toolUseId: "call_1", content: '{"echoed":"pong"}' },
            { kind: "tool-result", toolUseId: "call_2", content: "boom", isError: true },
          ],
        },
      ],
    });
    expect(request.temperature).toBe(0);
    expect(request.tools).toEqual([
      {
        type: "function",
        name: "echo__ping",
        description: "Echo.",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        strict: false,
      },
    ]);
    expect(request.tool_choice).toEqual({ type: "function", name: "echo__ping" });
    expect(request.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "ping" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
        ],
      },
      // Reasoning is dropped (provider-private, nothing stored to reference).
      { role: "assistant", content: "Calling the tool." },
      { type: "function_call", call_id: "call_1", name: "echo__ping", arguments: '{"text":"pong"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"echoed":"pong"}' },
      { type: "function_call_output", call_id: "call_2", output: "[tool error] boom" },
    ]);
  });
});

describe("parseServerSentEvents", () => {
  it("splits blocks across chunk boundaries, joins multi-line data, ignores comments, flushes the tail", async () => {
    const text =
      ": keep-alive\r\n\r\n" +
      "event: a\ndata: {\"x\":1}\n\n" +
      "event: b\r\ndata: line1\r\ndata: line2\r\n\r\n" +
      "data: tail";
    expect(await collect(parseServerSentEvents(streamOf(text, 3)))).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "b", data: "line1\nline2" },
      { event: "message", data: "tail" },
    ]);
  });

  it("cancels the body when the consumer stops early", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
      },
      cancel,
    });
    for await (const event of parseServerSentEvents(body)) {
      expect(event.data).toBe("1");
      break;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("ResponsesStreamTranslator", () => {
  const run = (events: Array<{ event: string; data: unknown }>) => {
    const translator = new ResponsesStreamTranslator("host/openai/v1/responses", 0);
    return events.flatMap((e) => translator.translate(e.event, JSON.stringify(e.data)));
  };

  it("streams text deltas and finishes with usage (cached tokens as cache reads), latency and an end_turn stop", () => {
    const out = run([
      { event: "response.created", data: { response: { id: "resp_1" } } },
      { event: "response.output_text.delta", data: { output_index: 0, delta: "Hel" } },
      { event: "response.output_text.delta", data: { output_index: 0, delta: "lo" } },
      { event: "response.output_text.delta", data: { output_index: 0, delta: "" } },
      {
        event: "response.completed",
        data: {
          response: {
            id: "resp_1",
            status: "completed",
            usage: {
              input_tokens: 120,
              input_tokens_details: { cached_tokens: 100 },
              output_tokens: 9,
              output_tokens_details: { reasoning_tokens: 4 },
            },
          },
        },
      },
    ]);
    expect(out).toEqual([
      { type: "text-delta", text: "Hel", blockIndex: 0 },
      { type: "text-delta", text: "lo", blockIndex: 0 },
      {
        type: "usage",
        inputTokens: 20,
        cacheReadInputTokens: 100,
        cacheWriteInputTokens: 0,
        tokensIn: 120,
        tokensOut: 9,
      },
      { type: "metadata", latencyMs: expect.any(Number) },
      {
        type: "stop",
        reason: "end_turn",
        additionalModelResponseFields: {
          endpoint: "host/openai/v1/responses",
          responseId: "resp_1",
          status: "completed",
        },
      },
    ]);
  });

  it("assembles a function call from added/delta/done and stops with tool_use", () => {
    const out = run([
      {
        event: "response.output_item.added",
        data: { output_index: 1, item: { type: "function_call", call_id: "call_1", name: "echo__ping", arguments: "" } },
      },
      { event: "response.function_call_arguments.delta", data: { output_index: 1, delta: '{"text":' } },
      { event: "response.function_call_arguments.delta", data: { output_index: 1, delta: '"pong"}' } },
      { event: "response.function_call_arguments.done", data: { output_index: 1, arguments: '{"text":"pong"}' } },
      {
        event: "response.output_item.done",
        data: { output_index: 1, item: { type: "function_call", call_id: "call_1", name: "echo__ping", arguments: '{"text":"pong"}' } },
      },
      { event: "response.completed", data: { response: { id: "resp_2", status: "completed" } } },
    ]);
    expect(out[0]).toEqual({
      type: "tool-use",
      id: "call_1",
      name: "echo__ping",
      input: { text: "pong" },
      blockIndex: 1,
    });
    expect(out.at(-1)).toMatchObject({ type: "stop", reason: "tool_use" });
  });

  it("maps max_output_tokens to the Converse max_tokens reason and emits a never-closed call at completion", () => {
    const out = run([
      {
        event: "response.output_item.added",
        data: { output_index: 0, item: { type: "function_call", call_id: "call_9", name: "t", arguments: "{" } },
      },
      {
        event: "response.incomplete",
        data: { response: { id: "resp_3", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
      },
    ]);
    // Malformed arguments → empty input (the handler rejects), Converse parity.
    expect(out[0]).toMatchObject({ type: "tool-use", id: "call_9", name: "t", input: {} });
    // A pending call counts as tool_use even on an incomplete response.
    expect(out.at(-1)).toMatchObject({
      type: "stop",
      reason: "tool_use",
      additionalModelResponseFields: { incompleteReason: "max_output_tokens" },
    });
    const truncated = run([
      { event: "response.output_text.delta", data: { output_index: 0, delta: "…" } },
      {
        event: "response.incomplete",
        data: { response: { id: "resp_4", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
      },
    ]);
    expect(truncated.at(-1)).toMatchObject({ type: "stop", reason: "max_tokens" });
  });

  it("throws on response.failed and error events, ignores unknown and malformed ones", () => {
    expect(() =>
      run([{ event: "response.failed", data: { response: { error: { code: "server_error", message: "boom" } } } }]),
    ).toThrow("Bedrock Responses API response failed (server_error): boom");
    expect(() => run([{ event: "error", data: { code: "rate_limit", message: "slow down" } }])).toThrow(
      "Bedrock Responses API stream error (rate_limit): slow down",
    );
    const translator = new ResponsesStreamTranslator("e");
    expect(translator.translate("response.output_text.delta", "not json")).toEqual([]);
    expect(translator.translate("response.reasoning_summary_text.delta", '{"delta":"x"}')).toEqual([]);
  });
});

describe("BedrockResponsesClient", () => {
  const credentials = { accessKeyId: "AKIATEST", secretAccessKey: "secret" };

  function fetchReturning(body: string, responseInit: ResponseInit = { status: 200 }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(streamOf(body), responseInit);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("POSTs a SigV4-signed, store:false request to bedrock-runtime's Responses path and streams the reply", async () => {
    const { calls, fetchImpl } = fetchReturning(
      sse([
        { event: "response.output_text.delta", data: { output_index: 0, delta: "ok" } },
        { event: "response.completed", data: { response: { id: "resp_1", status: "completed", usage: { input_tokens: 3, output_tokens: 1 } } } },
      ]),
    );
    const client = new BedrockResponsesClient({ region: "us-east-1", credentials, fetch: fetchImpl });
    const events = await collect(client.converseStream(BASE));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://bedrock-runtime.us-east-1.amazonaws.com${RESPONSES_API_PATH}`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=.*host.*, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    // No bearer token / API key anywhere.
    expect(Object.values(headers).join("\n")).not.toMatch(/Bearer/i);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ model: "us.openai.gpt-5.6-terra", store: false, stream: true });

    expect(events).toEqual([
      { type: "text-delta", text: "ok", blockIndex: 0 },
      { type: "usage", inputTokens: 3, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, tokensIn: 3, tokensOut: 1 },
      { type: "metadata", latencyMs: expect.any(Number) },
      {
        type: "stop",
        reason: "end_turn",
        additionalModelResponseFields: {
          endpoint: `bedrock-runtime.us-east-1.amazonaws.com${RESPONSES_API_PATH}`,
          responseId: "resp_1",
          status: "completed",
        },
      },
    ]);
  });

  it("surfaces a non-2xx as an error carrying status, AWS error type and provider message — never the request", async () => {
    const { fetchImpl } = fetchReturning(
      JSON.stringify({ message: "Too many requests, please wait before trying again." }),
      {
        status: 429,
        headers: {
          "x-amzn-errortype": "ThrottlingException:http://internal.amazon.com/coral/",
          "x-amzn-requestid": "req-123",
        },
      },
    );
    const client = new BedrockResponsesClient({ region: "us-east-1", credentials, fetch: fetchImpl });
    await expect(collect(client.converseStream(BASE))).rejects.toMatchObject({
      name: "ThrottlingException",
      message:
        "Bedrock Responses API request failed (HTTP 429 ThrottlingException; request id req-123): Too many requests, please wait before trying again.",
    });
    const { fetchImpl: openAiShaped } = fetchReturning(
      JSON.stringify({ error: { message: "Unsupported parameter: temperature", type: "invalid_request_error" } }),
      { status: 400 },
    );
    await expect(
      collect(new BedrockResponsesClient({ region: "us-east-1", credentials, fetch: openAiShaped }).converseStream(BASE)),
    ).rejects.toThrow("Bedrock Responses API request failed (HTTP 400): Unsupported parameter: temperature");
  });

  it("stops silently on abort and cancels the provider stream", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(
          new TextEncoder().encode(sse([{ event: "response.output_text.delta", data: { output_index: 0, delta: "x" } }])),
        );
      },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const client = new BedrockResponsesClient({ region: "us-east-1", credentials, fetch: fetchImpl });
    const seen: BedrockStreamEvent[] = [];
    for await (const event of client.converseStream({ ...BASE, signal: controller.signal })) {
      seen.push(event);
      controller.abort();
    }
    expect(seen).toEqual([{ type: "text-delta", text: "x", blockIndex: 0 }]);
    expect(cancel).toHaveBeenCalled();

    // Aborted before the request is answered: fetch's AbortError is swallowed.
    const aborted = new AbortController();
    aborted.abort();
    const rejecting = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    expect(
      await collect(
        new BedrockResponsesClient({ region: "us-east-1", credentials, fetch: rejecting }).converseStream({
          ...BASE,
          signal: aborted.signal,
        }),
      ),
    ).toEqual([]);
  });
});
