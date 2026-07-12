import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type { BedrockToolConfig } from "./registry";
import type { TokenUsage } from "./types";

/**
 * Minimal subset of Bedrock's converse-stream event surface that the loop
 * needs to consume. Mapping notes (when we wire the real client in PR #7):
 *
 *   AWS contentBlockDelta.delta.text         → { type: "text-delta", text }
 *   AWS contentBlockStart.start.toolUse      → start a pending tool call
 *   AWS contentBlockDelta.delta.toolUse.input → accumulate JSON for that call
 *   AWS contentBlockStop                      → flush pending tool call
 *   AWS metadata.usage                        → { type: "usage", ... }
 *   AWS messageStop                           → { type: "stop", reason }
 */
export type BedrockStreamEvent =
  | { type: "text-delta"; text: string }
  | {
      type: "tool-use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | ({ type: "usage" } & TokenUsage)
  | {
      type: "stop";
      reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    };

export interface BedrockMessage {
  role: "user" | "assistant";
  /**
   * Mixed content blocks. Bedrock accepts text blocks and toolResult blocks
   * inside user messages, and text blocks + toolUse blocks inside assistant
   * messages.
   */
  content: BedrockContentBlock[];
}

export type BedrockContentBlock =
  | { kind: "text"; text: string }
  | {
      kind: "image";
      format: "png" | "jpeg" | "webp";
      dataBase64: string;
    }
  | {
      kind: "tool-use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "tool-result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export interface ConverseStreamParams {
  /** The Bedrock-side model id (e.g. `us.anthropic.claude-sonnet-4-6-v1:0`). */
  bedrockModelId: string;
  /**
   * Stable system text. Must be byte-identical across turns of a conversation
   * — it sits inside the prompt-cache prefix, and any per-request byte
   * (timestamps, request ids) makes every turn a cache miss that still pays
   * the cache-write premium.
   */
  systemPrompt?: string;
  /**
   * System text rendered AFTER the cache checkpoint. Anything that varies per
   * request (e.g. the current clock) goes here, not in `systemPrompt`.
   */
  volatileSystemSuffix?: string;
  messages: BedrockMessage[];
  toolConfig?: BedrockToolConfig;
  maxTokens: number;
  /** Optional sampling temperature. Omitted for normal product defaults. */
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Single seam between the agent loop and AWS. PR #5 ships the fake;
 * PR #7 adds the real `@aws-sdk/client-bedrock-runtime` implementation
 * behind the same interface. Selecting between them is an env-var flip
 * (`BEDROCK_CLIENT=fake|real`).
 */
export interface BedrockClient {
  converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent>;
}

/**
 * Echoes the latest user message back as if streamed from a model, with
 * realistic deltas. Lets the rest of the system (chat UI, persistence,
 * tool plumbing) be exercised without an AWS account.
 *
 * Tunables:
 *   - `delayMs`        between deltas (default 30ms)
 *   - `chunkSize`      characters per delta (default 4)
 *   - `responsePrefix` text prepended to identify the fake (default "[fake] ")
 */
export interface FakeBedrockClientOptions {
  delayMs?: number;
  chunkSize?: number;
  responsePrefix?: string;
}

export class FakeBedrockClient implements BedrockClient {
  private readonly delayMs: number;
  private readonly chunkSize: number;
  private readonly prefix: string;

  constructor(opts: FakeBedrockClientOptions = {}) {
    this.delayMs = opts.delayMs ?? 30;
    this.chunkSize = opts.chunkSize ?? 4;
    this.prefix = opts.responsePrefix ?? "[fake] ";
  }

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    const lastUser = [...params.messages]
      .reverse()
      .find((m) => m.role === "user");
    const userText = lastUser
      ? lastUser.content
          .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
          .map((b) => b.text)
          .join("\n")
      : "";

    const reply =
      this.prefix +
      `you said: ${userText.length > 200 ? userText.slice(0, 200) + "…" : userText}` +
      `\n(model: ${params.bedrockModelId})`;

    let i = 0;
    while (i < reply.length) {
      if (params.signal?.aborted) {
        return;
      }
      const next = reply.slice(i, i + this.chunkSize);
      yield { type: "text-delta", text: next };
      i += this.chunkSize;
      if (this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
    }

    // Approximate token usage: ~4 chars per token.
    const tokensIn = Math.max(1, Math.ceil(userText.length / 4));
    const tokensOut = Math.max(1, Math.ceil(reply.length / 4));
    yield {
      type: "usage",
      tokensIn,
      tokensOut,
      inputTokens: tokensIn,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    yield { type: "stop", reason: "end_turn" };
  }
}

export class RealBedrockClient implements BedrockClient {
  private readonly client: BedrockRuntimeClient;

  constructor() {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error(
        "RealBedrockClient requires AWS_REGION or AWS_DEFAULT_REGION to be set.",
      );
    }
    this.client = new BedrockRuntimeClient({ region });
  }

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    const messages: Message[] = params.messages.map((m) => ({
      role: m.role,
      content: m.content.map((b): ContentBlock => {
        if (b.kind === "text") {
          return { text: b.text };
        }
        if (b.kind === "image") {
          return {
            image: {
              format: b.format,
              source: { bytes: Buffer.from(b.dataBase64, "base64") },
            },
          };
        }
        if (b.kind === "tool-use") {
          return {
            toolUse: {
              toolUseId: b.id,
              name: b.name,
              input: b.input as unknown as DocumentType,
            },
          };
        }
        return {
          toolResult: {
            toolUseId: b.toolUseId,
            content: [{ text: b.content }],
            status: b.isError ? "error" : "success",
          },
        };
      }),
    }));

    const toolConfig = toAwsToolConfiguration(params.toolConfig);

    // Prompt caching: Bedrock evaluates checkpoints in tools → system →
    // messages order, so the checkpoint after the stable system prompt covers
    // the tool definitions too. The volatile suffix renders after the
    // checkpoint so it can't invalidate the cached prefix. Prefixes below the
    // model's minimum (1,024 tokens on Sonnet 4.6; 4,096 on Sonnet 5 and
    // Haiku 4.5) are silently left uncached — never an error — so short
    // prompts are safe.
    const system: SystemContentBlock[] = [];
    if (params.systemPrompt) {
      system.push(
        { text: params.systemPrompt },
        { cachePoint: { type: "default" } },
      );
    }
    if (params.volatileSystemSuffix) {
      system.push({ text: params.volatileSystemSuffix });
    }

    const command = new ConverseStreamCommand({
      modelId: params.bedrockModelId,
      system: system.length > 0 ? system : undefined,
      messages,
      toolConfig,
      inferenceConfig: {
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      },
    });

    const response = await this.client.send(command);
    if (!response.stream) return;

    let pendingToolId: string | undefined;
    let pendingToolName: string | undefined;
    let pendingInputJson = "";

    for await (const chunk of response.stream) {
      if (params.signal?.aborted) return;

      if (chunk.contentBlockStart) {
        const start = chunk.contentBlockStart.start;
        if (start?.toolUse) {
          pendingToolId = start.toolUse.toolUseId;
          pendingToolName = start.toolUse.name;
          pendingInputJson = "";
        }
      } else if (chunk.contentBlockDelta) {
        const delta = chunk.contentBlockDelta.delta;
        if (delta?.text) {
          yield { type: "text-delta", text: delta.text };
        } else if (delta?.toolUse?.input) {
          pendingInputJson += delta.toolUse.input;
        }
      } else if (chunk.contentBlockStop) {
        if (pendingToolId && pendingToolName) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(pendingInputJson || "{}");
          } catch {
            // malformed — pass empty, handler will reject
          }
          yield { type: "tool-use", id: pendingToolId, name: pendingToolName, input };
          pendingToolId = undefined;
          pendingToolName = undefined;
          pendingInputJson = "";
        }
      } else if (chunk.messageStop) {
        const raw = chunk.messageStop.stopReason;
        const reason =
          raw === "tool_use"
            ? "tool_use"
            : raw === "max_tokens"
              ? "max_tokens"
              : raw === "stop_sequence"
                ? "stop_sequence"
                : "end_turn";
        yield { type: "stop", reason };
      } else if (chunk.metadata?.usage) {
        const usage = chunk.metadata.usage;
        yield {
          type: "usage",
          inputTokens: usage.inputTokens ?? 0,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
          // Preserve the original total alongside its separately billable
          // components so cost and cache-hit ratios remain measurable.
          tokensIn:
            (usage.inputTokens ?? 0) +
            (usage.cacheReadInputTokens ?? 0) +
            (usage.cacheWriteInputTokens ?? 0),
          tokensOut: usage.outputTokens ?? 0,
        };
      }
    }
  }
}

export function toAwsToolConfiguration(
  toolConfig?: BedrockToolConfig,
): ToolConfiguration | undefined {
  if (!toolConfig) return undefined;
  const tools = toolConfig.tools.map(
    (t): Tool => ({
      toolSpec: {
        name: t.toolSpec.name,
        description: t.toolSpec.description,
        inputSchema: {
          json: t.toolSpec.inputSchema.json as unknown as DocumentType,
        },
      },
    }),
  );
  // Checkpoint after the tool definitions so a mid-conversation system-prompt
  // change doesn't also evict the (larger, more stable) tools cache.
  tools.push({ cachePoint: { type: "default" } });
  return {
    tools,
    ...(toolConfig.toolChoice ? { toolChoice: toolConfig.toolChoice } : {}),
  };
}

/**
 * Resolves a `BedrockClient` based on env. Defaults to `fake` so local dev
 * works without AWS credentials. Set `BEDROCK_CLIENT=real` to use live Bedrock.
 */
export function getBedrockClient(): BedrockClient {
  const which = (process.env.BEDROCK_CLIENT ?? "fake").toLowerCase();
  if (which === "fake") return new FakeBedrockClient();
  if (which === "real") return new RealBedrockClient();
  throw new Error(`Unknown BEDROCK_CLIENT=${which}; expected 'fake' or 'real'`);
}
