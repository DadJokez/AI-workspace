import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type { BedrockToolConfig } from "./registry";

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
  | { type: "usage"; tokensIn: number; tokensOut: number }
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
  systemPrompt?: string;
  messages: BedrockMessage[];
  toolConfig?: BedrockToolConfig;
  maxTokens: number;
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
    yield { type: "usage", tokensIn, tokensOut };
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

    const command = new ConverseStreamCommand({
      modelId: params.bedrockModelId,
      system: params.systemPrompt ? [{ text: params.systemPrompt }] : undefined,
      messages,
      toolConfig,
      inferenceConfig: { maxTokens: params.maxTokens },
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
        yield {
          type: "usage",
          tokensIn: chunk.metadata.usage.inputTokens ?? 0,
          tokensOut: chunk.metadata.usage.outputTokens ?? 0,
        };
      }
    }
  }
}

export function toAwsToolConfiguration(
  toolConfig?: BedrockToolConfig,
): ToolConfiguration | undefined {
  if (!toolConfig) return undefined;
  return {
    tools: toolConfig.tools.map(
      (t): Tool => ({
        toolSpec: {
          name: t.toolSpec.name,
          description: t.toolSpec.description,
          inputSchema: {
            json: t.toolSpec.inputSchema.json as unknown as DocumentType,
          },
        },
      }),
    ),
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
