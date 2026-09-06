import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
  HttpRequest,
} from "@smithy/types";
import type {
  BedrockClient,
  BedrockMessage,
  BedrockStreamEvent,
  ConverseStreamParams,
} from "./clients";

/**
 * Bedrock's OpenAI-compatible Responses API behind the `BedrockClient` seam
 * (#660, #797 P4). Registry entries with `invocation: "responses"` — the
 * OpenAI GPT models — cannot be reached through Converse; this client maps
 * the loop's Converse-shaped request onto `POST /openai/v1/responses` and
 * the SSE stream back onto `BedrockStreamEvent`, so the shared agent loop
 * (tool policy, approvals, nonce framing, budgets, cancellation) is reused
 * unchanged.
 *
 * Decisions (the issue's design list, adapted to what Bedrock serves today):
 *
 * - Endpoint: the `bedrock-runtime` host, not `bedrock-mantle`. AWS serves
 *   the same Responses API on both, recommends `bedrock-runtime` for new
 *   applications, and — decisive here — authorizes it with the
 *   `bedrock:InvokeModel*` actions the ECS task role already holds (plus
 *   `bedrock:InvokeModel` on the account's default project). Mantle would
 *   need a new `bedrock-mantle:CreateInference` grant and a new egress host
 *   for the async/background features phase 1 does not use.
 * - Auth: SigV4 from the ambient AWS credential chain (task role in
 *   production, local creds in dev), signed with the SDK's own signer — no
 *   Bedrock API key, no new dependency. Signing service `bedrock`, same as
 *   Converse.
 * - `store: false` on every request: Comparative owns conversation
 *   persistence; Bedrock retains nothing and `previous_response_id` is
 *   never used. Retries/edits stay DB-backed by construction.
 * - Client-side function calling only. Tool schemas are sent with
 *   `strict: false` (the API's default is strict, which rejects most MCP
 *   schemas); results go back as `function_call_output` items.
 * - The stable system prompt and the volatile suffix are joined into
 *   `instructions` (the AgentCore lane does the same fold). Prompt caching on
 *   this route is implicit — no cache markers are sent; `cached_tokens` in
 *   the usage block are reported as cache reads.
 * - Reasoning: no summaries are requested and reasoning blocks from history
 *   are not replayed (with `store: false` they cannot be referenced anyway).
 *
 * Nothing here logs: no prompt, tool payload, header or response body ever
 * reaches stdout/stderr. Errors carry the HTTP status, the AWS error type
 * and the provider's message only.
 */

export const RESPONSES_API_PATH = "/openai/v1/responses";

export function responsesEndpointHost(region: string): string {
  return `bedrock-runtime.${region}.amazonaws.com`;
}

export interface BedrockResponsesClientOptions {
  region: string;
  /** Defaults to the SDK's default provider chain (env → profile → task role). */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** Injectable transport (tests). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Wire shape of one `POST /openai/v1/responses` body. */
export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesFunctionTool[];
  tool_choice?: { type: "function"; name: string };
  max_output_tokens: number;
  temperature?: number;
  stream: true;
  store: false;
}

export type ResponsesInputItem =
  | { role: "user"; content: ResponsesUserContentPart[] }
  | { role: "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponsesUserContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" };

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
}

/**
 * Converse-shaped loop request → Responses body. Pure and exported so tests
 * can pin the mapping (and `store: false`) without a transport.
 */
export function buildResponsesRequest(
  params: ConverseStreamParams,
): ResponsesRequest {
  const instructions = [params.systemPrompt, params.volatileSystemSuffix]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const tools = params.toolConfig?.tools.map(
    (tool): ResponsesFunctionTool => ({
      type: "function",
      name: tool.toolSpec.name,
      description: tool.toolSpec.description,
      parameters: tool.toolSpec.inputSchema.json,
      strict: false,
    }),
  );
  const forcedTool = params.toolConfig?.toolChoice?.tool.name;
  return {
    model: params.bedrockModelId,
    ...(instructions ? { instructions } : {}),
    input: params.messages.flatMap(toInputItems),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(forcedTool ? { tool_choice: { type: "function", name: forcedTool } } : {}),
    max_output_tokens: params.maxTokens,
    ...(params.temperature !== undefined
      ? { temperature: params.temperature }
      : {}),
    stream: true,
    store: false,
  };
}

function toInputItems(message: BedrockMessage): ResponsesInputItem[] {
  if (message.role === "assistant") {
    return message.content.flatMap((block): ResponsesInputItem[] => {
      if (block.kind === "text") {
        return [{ role: "assistant", content: block.text }];
      }
      if (block.kind === "tool-use") {
        return [
          {
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        ];
      }
      // Reasoning blocks are provider-private; with `store: false` there is
      // no stored item to reference and no summary was requested.
      return [];
    });
  }
  // Tool results are top-level items that must follow their function_call;
  // any text/image parts of the same Converse message form one user turn.
  const results: ResponsesInputItem[] = [];
  const parts: ResponsesUserContentPart[] = [];
  for (const block of message.content) {
    if (block.kind === "tool-result") {
      results.push({
        type: "function_call_output",
        call_id: block.toolUseId,
        // The Responses API has no error flag on a tool output; Converse's
        // `status: error` becomes a loop-authored label outside the nonce
        // frame so the model still sees which results failed.
        output: block.isError ? `[tool error] ${block.content}` : block.content,
      });
    } else if (block.kind === "text") {
      parts.push({ type: "input_text", text: block.text });
    } else if (block.kind === "image") {
      parts.push({
        type: "input_image",
        image_url: `data:image/${block.format};base64,${block.dataBase64}`,
        detail: "auto",
      });
    }
  }
  return parts.length > 0
    ? [...results, { role: "user", content: parts }]
    : results;
}

/** One `event:`/`data:` block of a server-sent-events stream. */
export interface ServerSentEvent {
  event: string;
  data: string;
}

/**
 * Minimal SSE reader: blocks are blank-line separated, `data:` lines join
 * with newlines, comments (`:`) are dropped. Cancels the body when the
 * consumer stops early so an aborted turn closes the provider connection.
 */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const block = parseSseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        if (block) yield block;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    const tail = parseSseBlock(buffer + decoder.decode());
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseSseBlock(raw: string): ServerSentEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":") || line.length === 0) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value =
      colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface PendingFunctionCall {
  callId?: string;
  name?: string;
  arguments: string;
}

/**
 * Responses SSE events → `BedrockStreamEvent`s, one iteration's worth of
 * state. Pure per event and exported so the mapping is unit-testable.
 *
 * Stop reasons follow Converse vocabulary because the loop keys on it:
 * any function call → `tool_use`; `incomplete_details.reason ===
 * "max_output_tokens"` → `max_tokens` (drives the truncation notice);
 * everything else → `end_turn`.
 */
export class ResponsesStreamTranslator {
  private readonly pending = new Map<number, PendingFunctionCall>();
  private functionCalls = 0;

  constructor(
    private readonly endpoint: string,
    private readonly startedAt = Date.now(),
  ) {}

  translate(event: string, data: string): BedrockStreamEvent[] {
    let payload: JsonRecord | undefined;
    try {
      payload = asRecord(JSON.parse(data));
    } catch {
      return [];
    }
    if (!payload) return [];

    switch (event) {
      case "response.output_text.delta": {
        const delta = payload.delta;
        return typeof delta === "string" && delta.length > 0
          ? [
              {
                type: "text-delta",
                text: delta,
                blockIndex: asNumber(payload.output_index),
              },
            ]
          : [];
      }
      case "response.output_item.added": {
        const item = asRecord(payload.item);
        if (item?.type === "function_call") {
          this.pending.set(asNumber(payload.output_index), {
            ...(typeof item.call_id === "string" ? { callId: item.call_id } : {}),
            ...(typeof item.name === "string" ? { name: item.name } : {}),
            arguments: typeof item.arguments === "string" ? item.arguments : "",
          });
        }
        return [];
      }
      case "response.function_call_arguments.delta": {
        const call = this.pendingAt(payload.output_index);
        if (typeof payload.delta === "string") call.arguments += payload.delta;
        return [];
      }
      case "response.function_call_arguments.done": {
        const call = this.pendingAt(payload.output_index);
        if (typeof payload.arguments === "string") {
          call.arguments = payload.arguments;
        }
        return [];
      }
      case "response.output_item.done": {
        const item = asRecord(payload.item);
        if (item?.type !== "function_call") return [];
        const index = asNumber(payload.output_index);
        const call = this.pendingAt(payload.output_index);
        this.pending.delete(index);
        return [
          this.toolUse(
            {
              callId: typeof item.call_id === "string" ? item.call_id : call.callId,
              name: typeof item.name === "string" ? item.name : call.name,
              arguments:
                typeof item.arguments === "string" ? item.arguments : call.arguments,
            },
            index,
          ),
        ];
      }
      case "response.completed":
      case "response.incomplete":
        return this.finish(asRecord(payload.response) ?? {});
      case "response.failed": {
        const error = asRecord(asRecord(payload.response)?.error);
        throw new Error(
          `Bedrock Responses API response failed${
            error ? ` (${String(error.code ?? "unknown")}): ${String(error.message ?? "")}` : ""
          }`,
        );
      }
      case "error":
        throw new Error(
          `Bedrock Responses API stream error (${String(payload.code ?? "unknown")}): ${String(payload.message ?? "")}`,
        );
      default:
        return [];
    }
  }

  private pendingAt(index: unknown): PendingFunctionCall {
    const key = asNumber(index);
    let call = this.pending.get(key);
    if (!call) {
      call = { arguments: "" };
      this.pending.set(key, call);
    }
    return call;
  }

  private toolUse(
    call: PendingFunctionCall,
    blockIndex: number,
  ): BedrockStreamEvent {
    this.functionCalls += 1;
    let input: Record<string, unknown> = {};
    try {
      input = asRecord(JSON.parse(call.arguments || "{}")) ?? {};
    } catch {
      // malformed — pass empty, the handler will reject (Converse parity)
    }
    return {
      type: "tool-use",
      id: call.callId ?? `call_${blockIndex}`,
      name: call.name ?? "",
      input,
      blockIndex,
    };
  }

  private finish(response: JsonRecord): BedrockStreamEvent[] {
    const events: BedrockStreamEvent[] = [];
    // A function call the stream never closed is still a call (the loop
    // must answer it or the transcript dangles).
    for (const [index, call] of [...this.pending].sort(([a], [b]) => a - b)) {
      events.push(this.toolUse(call, index));
    }
    this.pending.clear();

    const usage = asRecord(response.usage);
    if (usage) {
      const inputTotal = asNumber(usage.input_tokens);
      const cached = asNumber(asRecord(usage.input_tokens_details)?.cached_tokens);
      events.push({
        type: "usage",
        inputTokens: Math.max(0, inputTotal - cached),
        cacheReadInputTokens: cached,
        cacheWriteInputTokens: 0,
        tokensIn: inputTotal,
        // Reasoning tokens are part of output_tokens and billed as output.
        tokensOut: asNumber(usage.output_tokens),
      });
    }
    events.push({ type: "metadata", latencyMs: Date.now() - this.startedAt });

    const incomplete = asRecord(response.incomplete_details);
    const incompleteReason =
      typeof incomplete?.reason === "string" ? incomplete.reason : undefined;
    const reason =
      this.functionCalls > 0
        ? "tool_use"
        : incompleteReason === "max_output_tokens"
          ? "max_tokens"
          : incompleteReason === "content_filter"
            ? "content_filtered"
            : "end_turn";
    events.push({
      type: "stop",
      reason,
      // Run Inspector / audit: which endpoint served the step and the
      // provider's response id (opaque; with store:false not retrievable).
      additionalModelResponseFields: {
        endpoint: this.endpoint,
        ...(typeof response.id === "string" ? { responseId: response.id } : {}),
        ...(typeof response.status === "string" ? { status: response.status } : {}),
        ...(incompleteReason ? { incompleteReason } : {}),
      },
    });
    return events;
  }
}

export class BedrockResponsesClient implements BedrockClient {
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sdk: BedrockRuntimeClient;

  constructor(opts: BedrockResponsesClientOptions) {
    this.host = responsesEndpointHost(opts.region);
    this.fetchImpl = opts.fetch ?? fetch;
    // Used only for its resolved credential chain and SigV4 signer — the
    // request itself is plain HTTPS, since the SDK has no Responses command.
    this.sdk = new BedrockRuntimeClient({
      region: opts.region,
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
    });
  }

  /** `BedrockClient`'s method name is Converse heritage; the shape is one model step. */
  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    const body = JSON.stringify(buildResponsesRequest(params));
    const signer = await this.sdk.config.signer();
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname: this.host,
      path: RESPONSES_API_PATH,
      headers: {
        host: this.host,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body,
    } satisfies HttpRequest);

    const endpoint = `${this.host}${RESPONSES_API_PATH}`;
    const translator = new ResponsesStreamTranslator(endpoint);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${endpoint}`, {
        method: "POST",
        headers: signed.headers,
        body,
        signal: params.signal,
      });
    } catch (err) {
      if (params.signal?.aborted) return;
      throw err;
    }
    if (!response.ok) throw await httpError(response);
    if (!response.body) return;

    try {
      for await (const { event, data } of parseServerSentEvents(response.body)) {
        if (params.signal?.aborted) return;
        yield* translator.translate(event, data);
      }
    } catch (err) {
      if (params.signal?.aborted) return;
      throw err;
    }
  }
}

/**
 * Non-2xx → an Error whose message carries status, the AWS error type
 * (`x-amzn-errortype`), the AWS request id (what a support case asks for)
 * and the provider message — the vocabulary `isModelFailoverEligibleError`
 * already matches on (ThrottlingException, 429, AccessDenied…). Never the
 * request.
 */
async function httpError(response: Response): Promise<Error> {
  const errorType =
    response.headers.get("x-amzn-errortype")?.split(":")[0] ?? "";
  const requestId = response.headers.get("x-amzn-requestid") ?? "";
  let message = "";
  try {
    message = (await response.text()).slice(0, 2_000);
  } catch {
    // body not readable; the status line is enough
  }
  try {
    const parsed = asRecord(JSON.parse(message));
    const nested = asRecord(parsed?.error);
    message = String(nested?.message ?? parsed?.message ?? parsed?.Message ?? message);
  } catch {
    // not JSON; keep the raw text
  }
  const error = new Error(
    `Bedrock Responses API request failed (HTTP ${response.status}${errorType ? ` ${errorType}` : ""}${requestId ? `; request id ${requestId}` : ""})${message ? `: ${message}` : ""}`,
  );
  if (errorType) error.name = errorType;
  return error;
}
