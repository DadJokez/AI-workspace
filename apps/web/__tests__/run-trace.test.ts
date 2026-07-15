import { describe, expect, it, vi } from "vitest";
import {
  buildPersistedTraceEvents,
  createProviderTraceAccumulator,
  persistProviderTraceCapture,
} from "@/lib/run-trace";

describe("provider run trace capture", () => {
  it("captures redacted provider context, reasoning, and metadata in bounded events", () => {
    const trace = createProviderTraceAccumulator();
    trace.record({
      type: "provider-request",
      iteration: 0,
      request: {
        providerModelId: "us.anthropic.claude-sonnet-4-6",
        systemPrompt: "Use the connected tools.",
        volatileSystemSuffix: "Current date: 2026-07-15.",
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "Find the release notes." },
              { kind: "image", format: "png", sizeBytes: 1_024 },
            ],
          },
        ],
        tools: [
          {
            name: "github_search",
            description: "Search GitHub.",
            inputSchema: {
              type: "object",
              properties: {
                accessToken: { type: "string", default: "secret-value" },
              },
            },
          },
        ],
      },
    });
    trace.record({
      type: "provider-reasoning-delta",
      iteration: 0,
      blockIndex: 0,
      delta: "I should search the repository first.",
    });
    trace.record({
      type: "provider-response-metadata",
      iteration: 0,
      stopReason: "tool_use",
      latencyMs: 412,
    });

    const capture = trace.snapshot(new Date("2026-07-15T01:00:00.000Z"));
    const events = buildPersistedTraceEvents(capture);

    expect(capture.reasoning).toEqual({
      state: "available",
      blocks: [
        {
          iteration: 0,
          blockIndex: 0,
          text: "I should search the repository first.",
          textHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          redacted: false,
        },
      ],
    });
    expect(capture.requests[0]).toMatchObject({
      providerModelId: "us.anthropic.claude-sonnet-4-6",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      systemPromptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      messagesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(capture)).not.toContain("secret-value");
    expect(JSON.stringify(capture)).toContain("[redacted]");
    expect(events.map((event) => event.eventType)).toEqual([
      "provider_context_snapshot",
      "provider_reasoning",
      "provider_response_metadata",
    ]);
    expect(capture.limits.truncatedRequestCount).toBe(0);
  });

  it("records an honest absent state when the provider emits no reasoning", () => {
    const trace = createProviderTraceAccumulator();
    trace.record({
      type: "provider-response-metadata",
      iteration: 0,
      stopReason: "end_turn",
    });

    const capture = trace.snapshot();
    expect(capture.reasoning).toEqual({ state: "absent", blocks: [] });
    expect(buildPersistedTraceEvents(capture)[1]).toMatchObject({
      eventType: "provider_reasoning",
      status: "info",
      label: "Provider returned no inspectable reasoning",
    });
  });

  it("does not retain provider reasoning signatures or image bytes", () => {
    const trace = createProviderTraceAccumulator();
    trace.record({
      type: "provider-request",
      iteration: 1,
      request: {
        providerModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [
          {
            role: "assistant",
            content: [
              {
                kind: "reasoning",
                text: "Use the tool.",
                signaturePresent: true,
              },
              { kind: "reasoning-redacted", sizeBytes: 512 },
              { kind: "image", format: "png", sizeBytes: 2_048 },
            ],
          },
        ],
        tools: [],
      },
    });

    const serialized = JSON.stringify(trace.snapshot());
    expect(serialized).toContain('"signaturePresent":"[redacted]"');
    expect(serialized).toContain('"sizeBytes":2048');
    expect(serialized).not.toContain("dataBase64");
    expect(serialized).not.toContain('"signature":');
  });

  it("bounds durable context and reasoning capture", () => {
    const trace = createProviderTraceAccumulator();
    trace.record({
      type: "provider-request",
      iteration: 0,
      request: {
        providerModelId: "us.anthropic.claude-sonnet-4-6",
        messages: Array.from({ length: 40 }, (_, index) => ({
          role: "user" as const,
          content: [{ kind: "text" as const, text: `${index}:${"x".repeat(24_000)}` }],
        })),
        tools: [],
      },
    });
    trace.record({
      type: "provider-reasoning-delta",
      iteration: 0,
      blockIndex: 0,
      delta: "r".repeat(30_000),
    });

    const capture = trace.snapshot();
    expect(capture.requests[0]).toMatchObject({
      truncated: true,
      request: { truncated: true },
    });
    expect(capture.reasoning.blocks[0]).toMatchObject({ truncated: true });
    expect(capture.reasoning.blocks[0]?.text).toContain(
      "[truncated by standard trace policy]",
    );
    expect(capture.limits).toMatchObject({
      truncatedRequestCount: 1,
      truncatedReasoningBlockCount: 1,
    });
  });

  it("does not fail the chat when trace persistence fails", async () => {
    const trace = createProviderTraceAccumulator();
    trace.record({
      type: "provider-response-metadata",
      iteration: 0,
      stopReason: "end_turn",
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const db = {
      select: () => {
        throw new Error("trace database unavailable");
      },
    };

    await expect(
      persistProviderTraceCapture({
        db: db as never,
        runId: "run-uuid",
        capture: trace.snapshot(),
      }),
    ).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("provider-trace-persist-error"),
    );
    stderr.mockRestore();
  });
});
