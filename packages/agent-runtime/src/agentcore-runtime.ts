import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { AgentEvent } from "@ai-workspace/agent";

import type { AgentRuntime, TurnInput } from "./types";
import { pickHttpMcpServers } from "./bedrock-runtime";

/**
 * AgentCore-backed implementation of `AgentRuntime` (specs/003 spike).
 *
 * The agent loop itself runs inside an Amazon Bedrock AgentCore Runtime —
 * a session-isolated container AI Hub owns (apps/agentcore-agent) that
 * executes the same `runAgentLoop` + MCP toolchain as the in-process
 * Bedrock runtime. This adapter is a thin client: serialize the turn,
 * `InvokeAgentRuntime`, parse the SSE stream of `AgentEvent`s back out.
 *
 * Auth model: SigV4 from this service's IAM role to AgentCore
 * (`bedrock-agentcore:InvokeAgentRuntime`); per-user MCP bearer tokens ride
 * inside the payload over TLS. AgentCore Identity/Gateway can replace that
 * transit later without touching this seam.
 */
export interface AgentCoreRuntimeOptions {
  /** ARN of the AgentCore Runtime (AGENTCORE_RUNTIME_ARN). */
  runtimeArn: string;
  /** AWS region; defaults to the SDK's resolution chain. */
  region?: string;
  /** Optional endpoint qualifier (version); DEFAULT endpoint when omitted. */
  qualifier?: string;
  /** Injectable client for tests. */
  client?: Pick<BedrockAgentCoreClient, "send">;
}

export class AgentCoreRuntime implements AgentRuntime {
  readonly name = "agentcore" as const;

  private readonly opts: AgentCoreRuntimeOptions;
  private readonly client: Pick<BedrockAgentCoreClient, "send">;

  constructor(opts: AgentCoreRuntimeOptions) {
    this.opts = opts;
    this.client =
      opts.client ??
      new BedrockAgentCoreClient(opts.region ? { region: opts.region } : {});
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const sessionId = toRuntimeSessionId(input.threadId);
    await input.onRunStarted?.({
      runtime: this.name,
      providerRunId: sessionId,
      executionMode: "local",
    });

    const payload = JSON.stringify({
      threadId: input.threadId,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      firstTurnPreamble: input.firstTurnPreamble,
      messages: input.messages,
      mcpServers: pickHttpMcpServers(input.mcpServers),
      builtinTools: input.builtinTools,
      userId: input.context.userId,
    });

    let response;
    try {
      response = await this.client.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: this.opts.runtimeArn,
          runtimeSessionId: sessionId,
          ...(this.opts.qualifier ? { qualifier: this.opts.qualifier } : {}),
          contentType: "application/json",
          accept: "text/event-stream",
          payload: new TextEncoder().encode(payload),
        }),
        input.signal ? { abortSignal: input.signal } : {},
      );
    } catch (err) {
      yield {
        type: "error",
        message: `AgentCoreRuntime: invoke failed — ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    const stream = toByteIterable(response.response);
    if (!stream) {
      yield {
        type: "error",
        message: "AgentCoreRuntime: response had no readable stream.",
      };
      return;
    }

    if (response.contentType?.includes("text/event-stream")) {
      yield* parseAgentEventSse(stream);
      return;
    }

    // Non-streaming fallback: whole-body JSON, either AgentEvent[] or an
    // error envelope from the container.
    const text = await collectText(stream);
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const ev = coerceAgentEvent(item);
          if (ev) yield ev;
        }
        return;
      }
      const maybe = parsed as { error?: unknown };
      yield {
        type: "error",
        message:
          typeof maybe.error === "string"
            ? maybe.error
            : `AgentCoreRuntime: unexpected response (${text.slice(0, 200)})`,
      };
    } catch {
      yield {
        type: "error",
        message: `AgentCoreRuntime: unparseable response (${text.slice(0, 200)})`,
      };
    }
  }
}

/**
 * `runtimeSessionId` must be 33–256 chars. Thread ids are UUIDs (36 chars),
 * so they pass through; anything shorter is deterministically padded so the
 * same thread always maps to the same AgentCore session.
 */
export function toRuntimeSessionId(threadId: string): string {
  const cleaned = threadId.replace(/[^a-zA-Z0-9-_]/g, "-");
  if (cleaned.length >= 33) return cleaned.slice(0, 256);
  return `${cleaned}-${"0".repeat(33 - cleaned.length - 1)}`;
}

/**
 * Parse a `text/event-stream` byte stream into AgentEvents. The container
 * emits one JSON event per `data:` line; heartbeat comments are ignored.
 * Exported for tests.
 */
export async function* parseAgentEventSse(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<AgentEvent, void, void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const ev = parseSseEvent(rawEvent);
      if (ev) yield ev;
    }
  }
  buffer += decoder.decode();
  const tail = parseSseEvent(buffer);
  if (tail) yield tail;
}

function parseSseEvent(raw: string): AgentEvent | null {
  const dataLines = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  try {
    return coerceAgentEvent(JSON.parse(dataLines.join("\n")));
  } catch {
    return null;
  }
}

const EVENT_TYPES = new Set([
  "text-delta",
  "tool-call",
  "tool-result",
  "usage",
  "error",
  "done",
]);

function coerceAgentEvent(value: unknown): AgentEvent | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    EVENT_TYPES.has((value as { type: string }).type)
  ) {
    return value as AgentEvent;
  }
  return null;
}

async function collectText(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

function toByteIterable(body: unknown): AsyncIterable<Uint8Array> | null {
  if (!body) return null;
  if (typeof body === "object" && Symbol.asyncIterator in (body as object)) {
    return body as AsyncIterable<Uint8Array>;
  }
  const webStreamable = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
  };
  if (typeof webStreamable.transformToWebStream === "function") {
    const reader = webStreamable.transformToWebStream().getReader();
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      },
    };
  }
  return null;
}
