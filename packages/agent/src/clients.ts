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
import type { ModelInvocation } from "./models";
import type { BedrockToolConfig } from "./registry";
import { BedrockResponsesClient } from "./responses-client";
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
  | { type: "text-delta"; text: string; blockIndex?: number }
  | {
      type: "reasoning-text-delta";
      text: string;
      blockIndex: number;
    }
  | {
      type: "reasoning-signature-delta";
      signature: string;
      blockIndex: number;
    }
  | {
      type: "reasoning-redacted-delta";
      dataBase64: string;
      blockIndex: number;
    }
  | {
      type: "tool-use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      blockIndex?: number;
    }
  | ({ type: "usage" } & TokenUsage)
  | {
      type: "metadata";
      latencyMs?: number;
      performanceLatency?: string;
      serviceTier?: string;
    }
  | {
      type: "stop";
      reason: string;
      additionalModelResponseFields?: unknown;
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
    }
  | {
      kind: "reasoning";
      text: string;
      signature?: string;
    }
  | {
      kind: "reasoning-redacted";
      dataBase64: string;
    };

export interface ConverseStreamParams {
  /** The Bedrock-side model id (e.g. `us.anthropic.claude-sonnet-4-6-v1:0`). */
  bedrockModelId: string;
  /**
   * The registry's `supportsPromptCaching` for this model (#797 P1). Every
   * `cachePoint` block — after the stable system prompt and after the tool
   * definitions — is emitted only when this is true; a model that does not
   * honor checkpoints gets the same request without them.
   */
  supportsPromptCaching: boolean;
  /**
   * The registry's `invocation` route (#660, #797 P4). `RealBedrockClient`
   * sends `responses` models to Bedrock's OpenAI-compatible Responses API
   * (`BedrockResponsesClient`) and everything else to Converse. Optional so
   * the fakes and existing Converse callers are untouched; absent = converse.
   */
  invocation?: ModelInvocation;
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

/**
 * Deterministic model double for the real browser-to-runtime resource canary.
 *
 * Unlike FakeBedrockClient, this exercises an actual two-step agent loop:
 * first it calls the mounted `resources__query` MCP tool using the resource id
 * from the signed turn context; then it derives its answer only from the tool
 * result returned on the next model iteration. Selection is guarded by
 * E2E_TEST_MODE in getBedrockClient(), so production cannot opt into it by
 * setting BEDROCK_CLIENT alone.
 */
export class E2EResourceCanaryBedrockClient implements BedrockClient {
  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    const toolResult = latestToolResult(params.messages);
    if (toolResult) {
      const answer = answerFromResourceToolResult(toolResult);
      for (const text of chunkText(answer, 24)) {
        if (params.signal?.aborted) return;
        yield { type: "text-delta", text };
      }
      yield e2eUsageEvent(params, answer);
      yield { type: "stop", reason: "end_turn" };
      return;
    }

    const resourceId = selectedResourceId(params.volatileSystemSuffix);
    const resourceToolMounted = params.toolConfig?.tools.some(
      (tool) => tool.toolSpec.name === "resources__query",
    );
    if (!resourceId || !resourceToolMounted) {
      const message =
        "The E2E resource canary could not find a mounted, selected conversation resource.";
      yield { type: "text-delta", text: message };
      yield e2eUsageEvent(params, message);
      yield { type: "stop", reason: "end_turn" };
      return;
    }

    yield {
      type: "tool-use",
      id: "e2e-resource-canary-query",
      name: "resources__query",
      input: {
        resourceId,
        operation: "table_filter",
        filterColumn: "customer",
        filterOperator: "equals",
        filterValue: "CSV_CANARY_7391",
        limit: 1,
      },
    };
    yield e2eUsageEvent(params, "");
    yield { type: "stop", reason: "tool_use" };
  }
}

function latestToolResult(messages: readonly BedrockMessage[]): string | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    for (
      let blockIndex = message.content.length - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const block = message.content[blockIndex]!;
      if (
        block.kind === "tool-result" &&
        block.toolUseId === "e2e-resource-canary-query"
      ) {
        return block.content;
      }
    }
  }
  return null;
}

function selectedResourceId(volatileSystemSuffix?: string): string | null {
  const match = volatileSystemSuffix?.match(
    /"resourceId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i,
  );
  return match?.[1] ?? null;
}

function answerFromResourceToolResult(result: string): string {
  const parsed = parseResourceToolResult(result);
  if (parsed === null) {
    return "The E2E resource canary did not receive verified full-coverage tool evidence.";
  }
  if (!isJsonRecord(parsed) || !isJsonRecord(parsed.receipt)) {
    return "The E2E resource canary did not receive verified full-coverage tool evidence.";
  }
  const fullCoverage =
    parsed.receipt.sourceCoverage === "full" &&
    parsed.receipt.resultCoverage === "full";
  const row = Array.isArray(parsed.rows)
    ? parsed.rows.find(
        (candidate) =>
          isJsonRecord(candidate) &&
          candidate.customer === "CSV_CANARY_7391" &&
          typeof candidate.revenue === "string",
      )
    : undefined;
  if (!fullCoverage || !isJsonRecord(row)) {
    return "The E2E resource canary did not receive verified full-coverage tool evidence.";
  }
  return `The revenue for ${row.customer} is ${row.revenue}. Verified from the persisted CSV through resources__query with full source coverage.`;
}

function parseResourceToolResult(result: string): unknown | null {
  const framed = result.match(
    /<<<TOOL-RESULT ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>>>\n([\s\S]*?)\n<<<END-TOOL-RESULT \1>>>/i,
  );
  const payload = framed?.[2];
  if (payload === undefined) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunkText(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function e2eUsageEvent(
  params: ConverseStreamParams,
  output: string,
): BedrockStreamEvent {
  const inputChars = params.messages.reduce(
    (total, message) =>
      total +
      message.content.reduce(
        (subtotal, block) =>
          subtotal +
          (block.kind === "text"
            ? block.text.length
            : block.kind === "tool-result"
              ? block.content.length
              : 0),
        0,
      ),
    0,
  );
  const tokensIn = Math.max(1, Math.ceil(inputChars / 4));
  const tokensOut = Math.max(1, Math.ceil(output.length / 4));
  return {
    type: "usage",
    tokensIn,
    tokensOut,
    inputTokens: tokensIn,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}

/**
 * The real AWS client for every registry invocation route: Converse for
 * `converse` models, Bedrock's OpenAI-compatible Responses API for
 * `responses` models (#660). Dispatching here — on the metadata the loop
 * already passes — is what lets both runtime lanes, the AgentCore container
 * and the evals harness serve a GPT entry with no change of their own: they
 * all hold one `RealBedrockClient`, and the judge (a Claude model) keeps
 * going to Converse through the same object.
 */
export class RealBedrockClient implements BedrockClient {
  private readonly client: BedrockRuntimeClient;
  private readonly region: string;
  private responses?: BedrockResponsesClient;

  constructor() {
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) {
      throw new Error(
        "RealBedrockClient requires AWS_REGION or AWS_DEFAULT_REGION to be set.",
      );
    }
    this.region = region;
    this.client = new BedrockRuntimeClient({ region });
  }

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    if (params.invocation === "responses") {
      this.responses ??= new BedrockResponsesClient({ region: this.region });
      yield* this.responses.converseStream(params);
      return;
    }
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
        if (b.kind === "reasoning") {
          return {
            reasoningContent: {
              reasoningText: {
                text: b.text,
                signature: b.signature,
              },
            },
          };
        }
        if (b.kind === "reasoning-redacted") {
          return {
            reasoningContent: {
              redactedContent: Buffer.from(b.dataBase64, "base64"),
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

    const toolConfig = toAwsToolConfiguration(
      params.toolConfig,
      params.supportsPromptCaching,
    );

    // Prompt caching: Bedrock evaluates checkpoints in tools → system →
    // messages order, so the checkpoint after the stable system prompt covers
    // the tool definitions too. The volatile suffix renders after the
    // checkpoint so it can't invalidate the cached prefix. Prefixes below the
    // model's minimum (1,024 tokens on Sonnet 4.6; 4,096 on Haiku 4.5) are
    // silently left uncached — never an error — so short
    // prompts are safe. Checkpoints are only emitted for models whose
    // registry entry says they honor them (#797 P1).
    const system: SystemContentBlock[] = [];
    if (params.systemPrompt) {
      system.push({ text: params.systemPrompt });
      if (params.supportsPromptCaching) {
        system.push({ cachePoint: { type: "default" } });
      }
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

    const response = await this.client.send(
      command,
      params.signal ? { abortSignal: params.signal } : {},
    );
    if (!response.stream) return;

    let pendingToolId: string | undefined;
    let pendingToolName: string | undefined;
    let pendingToolBlockIndex: number | undefined;
    let pendingInputJson = "";

    for await (const chunk of response.stream) {
      if (params.signal?.aborted) return;

      if (chunk.contentBlockStart) {
        const start = chunk.contentBlockStart.start;
        if (start?.toolUse) {
          pendingToolId = start.toolUse.toolUseId;
          pendingToolName = start.toolUse.name;
          pendingToolBlockIndex = chunk.contentBlockStart.contentBlockIndex;
          pendingInputJson = "";
        }
      } else if (chunk.contentBlockDelta) {
        const delta = chunk.contentBlockDelta.delta;
        if (delta?.text) {
          yield {
            type: "text-delta",
            text: delta.text,
            blockIndex: chunk.contentBlockDelta.contentBlockIndex,
          };
        } else if (delta?.toolUse?.input) {
          pendingInputJson += delta.toolUse.input;
        } else if (delta?.reasoningContent) {
          const reasoning = delta.reasoningContent;
          const blockIndex = chunk.contentBlockDelta.contentBlockIndex ?? 0;
          if (typeof reasoning.text === "string") {
            yield {
              type: "reasoning-text-delta",
              text: reasoning.text,
              blockIndex,
            };
          } else if (typeof reasoning.signature === "string") {
            yield {
              type: "reasoning-signature-delta",
              signature: reasoning.signature,
              blockIndex,
            };
          } else if (reasoning.redactedContent) {
            yield {
              type: "reasoning-redacted-delta",
              dataBase64: Buffer.from(reasoning.redactedContent).toString(
                "base64",
              ),
              blockIndex,
            };
          }
        }
      } else if (chunk.contentBlockStop) {
        if (pendingToolId && pendingToolName) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(pendingInputJson || "{}");
          } catch {
            // malformed — pass empty, handler will reject
          }
          yield {
            type: "tool-use",
            id: pendingToolId,
            name: pendingToolName,
            input,
            blockIndex: pendingToolBlockIndex,
          };
          pendingToolId = undefined;
          pendingToolName = undefined;
          pendingToolBlockIndex = undefined;
          pendingInputJson = "";
        }
      } else if (chunk.messageStop) {
        yield {
          type: "stop",
          reason: chunk.messageStop.stopReason ?? "end_turn",
          additionalModelResponseFields:
            chunk.messageStop.additionalModelResponseFields,
        };
      } else if (chunk.metadata) {
        const usage = chunk.metadata.usage;
        if (usage) {
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
        const latencyMs = chunk.metadata.metrics?.latencyMs;
        const performanceLatency = chunk.metadata.performanceConfig?.latency;
        const serviceTier = chunk.metadata.serviceTier?.type;
        if (latencyMs !== undefined || performanceLatency || serviceTier) {
          yield {
            type: "metadata",
            ...(latencyMs !== undefined ? { latencyMs } : {}),
            ...(performanceLatency ? { performanceLatency } : {}),
            ...(serviceTier ? { serviceTier } : {}),
          };
        }
      }
    }
  }
}

export function toAwsToolConfiguration(
  toolConfig: BedrockToolConfig | undefined,
  supportsPromptCaching: boolean,
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
  if (supportsPromptCaching) {
    tools.push({ cachePoint: { type: "default" } });
  }
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
  if (which === "e2e-resource-canary") {
    if (process.env.E2E_TEST_MODE !== "1") {
      throw new Error(
        "BEDROCK_CLIENT=e2e-resource-canary is restricted to E2E_TEST_MODE=1.",
      );
    }
    return new E2EResourceCanaryBedrockClient();
  }
  throw new Error(
    `Unknown BEDROCK_CLIENT=${which}; expected 'fake', 'real', or 'e2e-resource-canary'`,
  );
}
