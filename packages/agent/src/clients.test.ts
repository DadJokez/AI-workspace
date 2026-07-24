import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedrockRuntimeClient,
  type ConverseStreamCommand,
  type ConverseStreamCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  E2EResourceCanaryBedrockClient,
  RealBedrockClient,
  getBedrockClient,
  toAwsToolConfiguration,
  type BedrockMessage,
  type BedrockStreamEvent,
  type ConverseStreamParams,
} from "./clients";
import type { BedrockToolConfig } from "./registry";
import { frameUntrustedToolResult } from "./tool-result-framing";

/** Loose chunk shape so tests can feed exactly the fields the client reads. */
type StreamChunk = Record<string, unknown>;

/**
 * Stubs `BedrockRuntimeClient.send`, capturing each command's input and
 * replaying the given chunks as the response stream.
 */
function stubSend(
  chunks: StreamChunk[] = [],
  sendOptions?: Array<{ abortSignal?: AbortSignal } | undefined>,
) {
  const inputs: ConverseStreamCommandInput[] = [];
  vi.spyOn(
    BedrockRuntimeClient.prototype as unknown as {
      send: (
        command: ConverseStreamCommand,
        options?: { abortSignal?: AbortSignal },
      ) => Promise<{ stream: AsyncIterable<StreamChunk> }>;
    },
    "send",
  ).mockImplementation(async (command, options) => {
    inputs.push(command.input);
    sendOptions?.push(options);
    return {
      stream: (async function* () {
        yield* chunks;
      })(),
    };
  });
  return inputs;
}

async function collect(
  iter: AsyncIterable<BedrockStreamEvent>,
): Promise<BedrockStreamEvent[]> {
  const events: BedrockStreamEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

const TOOL_CONFIG: BedrockToolConfig = {
  tools: [
    {
      toolSpec: {
        name: "top_song",
        description: "Get the most popular song on a station.",
        inputSchema: { json: { type: "object", properties: {} } },
      },
    },
  ],
};

const RESOURCE_TOOL_CONFIG: BedrockToolConfig = {
  tools: [
    {
      toolSpec: {
        name: "resources__query",
        description: "Query a selected conversation resource.",
        inputSchema: { json: { type: "object", properties: {} } },
      },
    },
  ],
};

describe("E2EResourceCanaryBedrockClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is impossible to select outside explicit E2E test mode", () => {
    vi.stubEnv("BEDROCK_CLIENT", "e2e-resource-canary");
    vi.stubEnv("E2E_TEST_MODE", "0");

    expect(() => getBedrockClient()).toThrow(
      "restricted to E2E_TEST_MODE=1",
    );
  });

  it("calls the real resource tool with the id selected by turn context", async () => {
    const client = new E2EResourceCanaryBedrockClient();
    const resourceId = "123e4567-e89b-42d3-a456-426614174000";
    const events = await collect(
      client.converseStream(
        resourceCanaryParams({
          volatileSystemSuffix: `<<<CONVERSATION-RESOURCES nonce>>>[{"resourceId":"${resourceId}","filename":"core.csv"}]<<<END-CONVERSATION-RESOURCES nonce>>>`,
        }),
      ),
    );

    expect(events).toContainEqual({
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
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("derives the answer from full-coverage tool evidence instead of a canned value", async () => {
    const client = new E2EResourceCanaryBedrockClient();
    const messages: BedrockMessage[] = [
      {
        role: "user",
        content: [
          {
            kind: "tool-result",
            toolUseId: "e2e-resource-canary-query",
            content: frameUntrustedToolResult(
              "resources__query",
              JSON.stringify({
                receipt: {
                  sourceCoverage: "full",
                  resultCoverage: "full",
                },
                rows: [
                  {
                    _sheet: "Data",
                    revenue: "73155",
                    customer: "CSV_CANARY_7391",
                  },
                ],
              }),
            ),
          },
        ],
      },
    ];
    const events = await collect(
      client.converseStream(resourceCanaryParams({ messages })),
    );
    const answer = events
      .filter(
        (
          event,
        ): event is Extract<BedrockStreamEvent, { type: "text-delta" }> =>
          event.type === "text-delta",
      )
      .map((event) => event.text)
      .join("");

    expect(answer).toContain("CSV_CANARY_7391 is 73155");
    expect(answer).toContain("resources__query");
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end_turn" });
  });

  it("does not claim a value when the tool result lacks full evidence", async () => {
    const client = new E2EResourceCanaryBedrockClient();
    const messages: BedrockMessage[] = [
      {
        role: "user",
        content: [
          {
            kind: "tool-result",
            toolUseId: "e2e-resource-canary-query",
            content: frameUntrustedToolResult(
              "resources__query",
              '{"receipt":{"sourceCoverage":"partial"},"rows":[{"customer":"CSV_CANARY_7391","revenue":"99999"}]}',
            ),
          },
        ],
      },
    ];
    const events = await collect(
      client.converseStream(resourceCanaryParams({ messages })),
    );
    const answer = events
      .filter(
        (
          event,
        ): event is Extract<BedrockStreamEvent, { type: "text-delta" }> =>
          event.type === "text-delta",
      )
      .map((event) => event.text)
      .join("");

    expect(answer).toContain("did not receive verified");
    expect(answer).not.toContain("99999");
  });

  it("rejects an unframed result even when its data would otherwise pass", async () => {
    const client = new E2EResourceCanaryBedrockClient();
    const events = await collect(
      client.converseStream(
        resourceCanaryParams({
          messages: [
            {
              role: "user",
              content: [
                {
                  kind: "tool-result",
                  toolUseId: "e2e-resource-canary-query",
                  content:
                    '{"receipt":{"sourceCoverage":"full","resultCoverage":"full"},"rows":[{"customer":"CSV_CANARY_7391","revenue":"73155"}]}',
                },
              ],
            },
          ],
        }),
      ),
    );
    const answer = events
      .filter(
        (
          event,
        ): event is Extract<BedrockStreamEvent, { type: "text-delta" }> =>
          event.type === "text-delta",
      )
      .map((event) => event.text)
      .join("");

    expect(answer).toContain("did not receive verified");
    expect(answer).not.toContain("73155");
  });
});

function resourceCanaryParams(
  overrides: Partial<ConverseStreamParams> = {},
): ConverseStreamParams {
  return {
    bedrockModelId: "us.anthropic.claude-sonnet-4-6",
    messages: [
      {
        role: "user",
        content: [{ kind: "text", text: "Read the attached CSV." }],
      },
    ],
    toolConfig: RESOURCE_TOOL_CONFIG,
    maxTokens: 100,
    ...overrides,
  };
}

describe("toAwsToolConfiguration", () => {
  it("returns undefined when no tool config is given", () => {
    expect(toAwsToolConfiguration(undefined)).toBeUndefined();
  });

  it("appends a cachePoint after the tool definitions", () => {
    const cfg = toAwsToolConfiguration(TOOL_CONFIG);
    expect(cfg?.tools).toHaveLength(2);
    expect(cfg?.tools?.[0]).toMatchObject({
      toolSpec: { name: "top_song" },
    });
    expect(cfg?.tools?.[1]).toEqual({ cachePoint: { type: "default" } });
  });

  it("passes a specific tool choice to the AWS configuration", () => {
    const cfg = toAwsToolConfiguration({
      ...TOOL_CONFIG,
      toolChoice: { tool: { name: "top_song" } },
    });
    expect(cfg?.toolChoice).toEqual({ tool: { name: "top_song" } });
  });
});

describe("RealBedrockClient prompt caching", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_REGION", "us-east-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("places a cachePoint after the system prompt", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        systemPrompt: "You are a helpful assistant.",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.system).toEqual([
      { text: "You are a helpful assistant." },
      { cachePoint: { type: "default" } },
    ]);
  });

  it("forwards an explicit sampling temperature to Bedrock", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-haiku-4-5",
        messages: [{ role: "user", content: [{ kind: "text", text: "judge" }] }],
        maxTokens: 200,
        temperature: 0,
      }),
    );

    expect(inputs[0]?.inferenceConfig).toEqual({
      maxTokens: 200,
      temperature: 0,
    });
  });

  it("passes the turn abort signal to the Bedrock SDK request", async () => {
    const sendOptions: Array<{ abortSignal?: AbortSignal } | undefined> = [];
    stubSend([], sendOptions);
    const client = new RealBedrockClient();
    const controller = new AbortController();

    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
        signal: controller.signal,
      }),
    );

    expect(sendOptions).toEqual([{ abortSignal: controller.signal }]);
  });

  it("renders the volatile suffix after the cache checkpoint", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        systemPrompt: "You are a helpful assistant.",
        volatileSystemSuffix: "Current date and time (UTC): 2026-07-09T01:00:00.000Z.",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(inputs[0]?.system).toEqual([
      { text: "You are a helpful assistant." },
      { cachePoint: { type: "default" } },
      { text: "Current date and time (UTC): 2026-07-09T01:00:00.000Z." },
    ]);
  });

  it("sends a volatile-only system without a cachePoint", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        volatileSystemSuffix: "Current date and time (UTC): 2026-07-09T01:00:00.000Z.",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(inputs[0]?.system).toEqual([
      { text: "Current date and time (UTC): 2026-07-09T01:00:00.000Z." },
    ]);
  });

  it("omits system entirely (no orphan cachePoint) without a system prompt", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(inputs[0]?.system).toBeUndefined();
    expect(inputs[0]?.toolConfig).toBeUndefined();
  });

  it("sends the tool cachePoint through the Converse command", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        systemPrompt: "s",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        toolConfig: TOOL_CONFIG,
        maxTokens: 100,
      }),
    );

    const tools = inputs[0]?.toolConfig?.tools;
    expect(tools?.at(-1)).toEqual({ cachePoint: { type: "default" } });
    // Messages carry no cachePoint — only system and tools are cached.
    expect(inputs[0]?.messages).toEqual([
      { role: "user", content: [{ text: "hi" }] },
    ]);
  });

  it("preserves cache reads and writes alongside total tokensIn", async () => {
    stubSend([
      {
        metadata: {
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cacheReadInputTokens: 900,
            cacheWriteInputTokens: 50,
          },
        },
      },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    const client = new RealBedrockClient();
    const events = await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(events).toContainEqual({
      type: "usage",
      tokensIn: 1050,
      tokensOut: 20,
      inputTokens: 100,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 50,
    });
  });

  it("reports plain inputTokens when the response has no cache fields", async () => {
    stubSend([
      { metadata: { usage: { inputTokens: 42, outputTokens: 7 } } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    const client = new RealBedrockClient();
    const events = await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(events).toContainEqual({
      type: "usage",
      tokensIn: 42,
      tokensOut: 7,
      inputTokens: 42,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });

  it("maps provider reasoning and response metadata without exposing signatures as text", async () => {
    stubSend([
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { text: "I should inspect the repo." } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { signature: "signed-reasoning" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: {
            reasoningContent: {
              redactedContent: Buffer.from("encrypted"),
            },
          },
        },
      },
      {
        messageStop: {
          stopReason: "end_turn",
          additionalModelResponseFields: { traceId: "provider-trace" },
        },
      },
      {
        metadata: {
          metrics: { latencyMs: 321 },
          performanceConfig: { latency: "standard" },
          serviceTier: { type: "default" },
        },
      },
    ]);
    const client = new RealBedrockClient();
    const events = await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        maxTokens: 100,
      }),
    );

    expect(events).toEqual([
      {
        type: "reasoning-text-delta",
        text: "I should inspect the repo.",
        blockIndex: 0,
      },
      {
        type: "reasoning-signature-delta",
        signature: "signed-reasoning",
        blockIndex: 0,
      },
      {
        type: "reasoning-redacted-delta",
        dataBase64: Buffer.from("encrypted").toString("base64"),
        blockIndex: 1,
      },
      {
        type: "stop",
        reason: "end_turn",
        additionalModelResponseFields: { traceId: "provider-trace" },
      },
      {
        type: "metadata",
        latencyMs: 321,
        performanceLatency: "standard",
        serviceTier: "default",
      },
    ]);
  });

  it("passes preserved reasoning blocks back to Bedrock", async () => {
    const inputs = stubSend();
    const client = new RealBedrockClient();
    await collect(
      client.converseStream({
        bedrockModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [
          {
            role: "assistant",
            content: [
              {
                kind: "reasoning",
                text: "Use the connected tool.",
                signature: "signed-reasoning",
              },
              {
                kind: "reasoning-redacted",
                dataBase64: Buffer.from("encrypted").toString("base64"),
              },
            ],
          },
        ],
        maxTokens: 100,
      }),
    );

    expect(inputs[0]?.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            reasoningContent: {
              reasoningText: {
                text: "Use the connected tool.",
                signature: "signed-reasoning",
              },
            },
          },
          {
            reasoningContent: {
              redactedContent: Buffer.from("encrypted"),
            },
          },
        ],
      },
    ]);
  });
});
