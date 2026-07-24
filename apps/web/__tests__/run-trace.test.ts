import { describe, expect, it, vi } from "vitest";
import {
  buildPersistedTraceEvents,
  createProviderTraceAccumulator,
  expandProviderContextSnapshotOutput,
  maybeScheduleTracePayloadPrune,
  persistProviderTraceCapture,
  pruneExpiredTracePayloads,
  resetTracePrunePacingForTests,
  tracePayloadPruneCutoff,
  TRACE_PAYLOAD_EVENT_TYPES,
  TRACE_PAYLOAD_RETENTION_DAYS,
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

  it("adds a typed abort reason to every provider trace event", () => {
    const trace = createProviderTraceAccumulator();
    trace.record({
      type: "provider-response-metadata",
      iteration: 0,
      stopReason: "error",
    });

    const events = buildPersistedTraceEvents(trace.snapshot(), {
      abortReason: "shutdown",
    });

    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.metadata).toMatchObject({ abortReason: "shutdown" });
    }
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

  it("structurally redacts JSON-shaped secrets inside tool-result strings", () => {
    const trace = createProviderTraceAccumulator();
    trace.record({
      type: "provider-request",
      iteration: 1,
      request: {
        providerModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              {
                kind: "tool-result",
                toolUseId: "tool-call-1",
                content:
                  '{"access_token":"opaque-custom-credential","nested":{"safe":"visible"}}',
              },
            ],
          },
        ],
        tools: [],
      },
    });

    const capture = trace.snapshot();
    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain("opaque-custom-credential");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("visible");
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
    // v2 (#386): the oversized transcript is deduplicated into the shared
    // section, so the byte budget lands there — with explicit metadata —
    // while the per-iteration entry stays intact.
    expect(capture.shared.messagesTruncated).toBe(true);
    expect(capture.shared.messages).toMatchObject({
      truncated: true,
      originalSizeBytes: expect.any(Number),
    });
    expect(capture.requests[0]?.truncated).toBeUndefined();
    expect(capture.reasoning.blocks[0]).toMatchObject({ truncated: true });
    expect(capture.reasoning.blocks[0]?.text).toContain(
      "[truncated by standard trace policy]",
    );
    expect(capture.limits).toMatchObject({
      truncatedReasoningBlockCount: 1,
    });
    expect(capture.limits.storage.storedBytes).toBeLessThan(
      capture.limits.contextByteLimit,
    );
    expect(capture.limits.storage.originalBytes).toBeGreaterThan(
      capture.limits.contextByteLimit,
    );
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

/**
 * #386 — deduplicated storage, reconstruction parity, retention.
 */
describe("run-trace.v2 deduplication", () => {
  const catalog = Array.from({ length: 40 }, (_tool, index) => ({
    name: `github_tool_${index}`,
    description: `Does GitHub thing number ${index}. ${"d".repeat(600)}`,
    inputSchema: { type: "object", properties: {} },
  }));
  const systemPrompt = `You are the harness. ${"s".repeat(8_000)}`;

  function recordIterations(count: number) {
    const trace = createProviderTraceAccumulator();
    const messages: Array<{ role: "user" | "assistant"; content: unknown[] }> =
      [{ role: "user", content: [{ kind: "text", text: "start" }] }];
    for (let iteration = 0; iteration < count; iteration += 1) {
      trace.record({
        type: "provider-request",
        iteration,
        request: {
          providerModelId: "us.anthropic.claude-sonnet-4-6",
          systemPrompt,
          messages: messages.map((message) => ({ ...message })),
          tools: catalog,
        } as never,
      });
      messages.push(
        { role: "assistant", content: [{ kind: "text", text: `step ${iteration}` }] },
        { role: "user", content: [{ kind: "tool-result", toolUseId: `t${iteration}`, content: "ok" }] },
      );
    }
    return trace;
  }

  it("stores the unchanged catalog and system prompt exactly once across iterations", () => {
    for (const iterations of [1, 2, 5]) {
      const capture = recordIterations(iterations).snapshot();
      expect(capture.requests).toHaveLength(iterations);
      expect(Object.keys(capture.shared.tools)).toHaveLength(1);
      expect(Object.keys(capture.shared.systemPrompts)).toHaveLength(1);
      const serialized = JSON.stringify(capture);
      expect(serialized.match(/github_tool_39/g)).toHaveLength(1);
      // Every iteration references the same shared content by hash.
      const toolsHashes = new Set(capture.requests.map((request) => request.toolsHash));
      expect(toolsHashes.size).toBe(1);
      expect([...toolsHashes][0]! in capture.shared.tools).toBe(true);
    }
  });

  it("records per-iteration transcripts as prefixes of the shared transcript", () => {
    const capture = recordIterations(3).snapshot();
    expect(Array.isArray(capture.shared.messages)).toBe(true);
    const counts = capture.requests.map((request) => request.messagesCount);
    expect(counts).toEqual([1, 3, 5]);
    expect(capture.requests.every((request) => !request.messagesInline)).toBe(true);
  });

  it("benchmark: a three-iteration tool run stores a fraction of the v1 bytes", () => {
    const capture = recordIterations(3).snapshot();
    const { storedBytes, originalBytes } = capture.limits.storage;
    expect(storedBytes).toBeGreaterThan(0);
    // v1 would repeat the ~30KB catalog + ~8KB prompt on every iteration.
    expect(storedBytes).toBeLessThan(originalBytes / 2);
    process.stdout.write(
      `[trace-storage-benchmark] iterations=3 v1Bytes=${originalBytes} v2Bytes=${storedBytes} saved=${Math.round((1 - storedBytes / originalBytes) * 100)}%\n`,
    );
  });

  it("reconstructs the v1 per-request timeline from a v2 snapshot", () => {
    const capture = recordIterations(2).snapshot();
    const expanded = expandProviderContextSnapshotOutput({
      shared: capture.shared,
      requests: capture.requests,
    }) as { requests: Array<Record<string, unknown>> };

    expect(expanded.requests).toHaveLength(2);
    for (const [index, request] of expanded.requests.entries()) {
      const payload = request.request as Record<string, unknown>;
      expect(Array.isArray(payload.tools)).toBe(true);
      expect((payload.tools as unknown[]).length).toBe(40);
      expect(typeof payload.systemPrompt).toBe("string");
      expect(Array.isArray(payload.messages)).toBe(true);
      expect((payload.messages as unknown[]).length).toBe(1 + index * 2);
      expect(request.messagesCount).toBeUndefined();
    }
  });

  it("passes v1 snapshot payloads through expansion untouched", () => {
    const v1Output = {
      requests: [
        { iteration: 0, request: { providerModelId: "m", messages: [], tools: [] } },
      ],
    };
    expect(expandProviderContextSnapshotOutput(v1Output)).toBe(v1Output);
  });

  it("round-trips a non-prefix iteration through messagesInline", () => {
    const trace = createProviderTraceAccumulator();
    trace.record({
      type: "provider-request",
      iteration: 0,
      request: {
        providerModelId: "us.anthropic.claude-sonnet-4-6",
        messages: [
          { role: "user", content: [{ kind: "text", text: "divergent" }] },
        ],
        tools: catalog,
      } as never,
    });
    trace.record({
      type: "provider-request",
      iteration: 1,
      request: {
        providerModelId: "us.anthropic.claude-sonnet-4-6",
        // NOT an extension of iteration 0 — the future-proofing branch.
        messages: [
          { role: "user", content: [{ kind: "text", text: "rewritten" }] },
          { role: "assistant", content: [{ kind: "text", text: "later" }] },
        ],
        tools: catalog,
      } as never,
    });

    const capture = trace.snapshot();
    expect(capture.requests[0]?.messagesInline).toBe(true);
    const expanded = expandProviderContextSnapshotOutput({
      shared: capture.shared,
      requests: capture.requests,
    }) as { requests: Array<{ request: Record<string, unknown> }> };
    const first = expanded.requests[0]!.request.messages as Array<{
      content: Array<{ text?: string }>;
    }>;
    expect(first[0]?.content[0]?.text).toBe("divergent");
    expect(first).toHaveLength(1);
  });

  it("prunes expired payload events but never the metrics event, at most once per interval", async () => {
    resetTracePrunePacingForTests();
    const captured: unknown[] = [];
    const db = {
      delete: (table: unknown) => ({
        where: (condition: unknown) => {
          captured.push({ table, condition });
          return Promise.resolve([]);
        },
      }),
    };
    // Paced entry point: first call fires, an immediate second call is a
    // no-op — the hot chat path never repeats the table-wide delete.
    expect(
      maybeScheduleTracePayloadPrune({
        db: db as never,
        now: new Date("2026-07-17T00:00:00.000Z"),
      }),
    ).toBe(true);
    expect(
      maybeScheduleTracePayloadPrune({
        db: db as never,
        now: new Date("2026-07-17T00:05:00.000Z"),
      }),
    ).toBe(false);
    expect(
      maybeScheduleTracePayloadPrune({
        db: db as never,
        now: new Date("2026-07-17T07:00:00.000Z"),
      }),
    ).toBe(true);
    await Promise.resolve();

    captured.length = 0;
    await pruneExpiredTracePayloads({
      db: db as never,
      now: new Date("2026-07-17T00:00:00.000Z"),
    });
    // One bounded delete fired; the pruned set and cutoff are pinned via
    // their exported definitions (the drizzle condition itself is opaque).
    expect(captured).toHaveLength(1);
    expect(TRACE_PAYLOAD_EVENT_TYPES).toEqual([
      "provider_context_snapshot",
      "provider_reasoning",
    ]);
    expect(TRACE_PAYLOAD_EVENT_TYPES).not.toContain(
      "provider_response_metadata",
    );
    expect(
      tracePayloadPruneCutoff(new Date("2026-07-17T00:00:00.000Z")),
    ).toEqual(
      new Date(
        Date.UTC(2026, 6, 17) -
          TRACE_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      ),
    );
  });
});
