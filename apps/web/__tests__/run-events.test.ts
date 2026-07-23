import { describe, expect, it } from "vitest";
import type { Database } from "@ai-workspace/db";
import {
  appendRunEventWithNextSequence,
  appendToolCallRunEvent,
  runEventsToActivityEvents,
} from "@/lib/run-events";

describe("runEventsToActivityEvents", () => {
  it("keeps the latest event for each tool call and preserves lifecycle events", () => {
    const events = runEventsToActivityEvents([
      {
        id: "evt_1",
        sequence: 1,
        eventType: "worker_started",
        status: "pending",
        label: "Started chat run",
        toolCallId: null,
        error: null,
        occurredAt: new Date("2026-05-18T12:00:00Z"),
      },
      {
        id: "evt_2",
        sequence: 2,
        eventType: "tool_call",
        status: "pending",
        label: "Searching GitHub...",
        toolCallId: "tool_1",
        error: null,
        occurredAt: new Date("2026-05-18T12:00:01Z"),
      },
      {
        id: "evt_3",
        sequence: 3,
        eventType: "tool_result",
        status: "succeeded",
        label: "Searched GitHub",
        toolCallId: "tool_1",
        error: null,
        occurredAt: new Date("2026-05-18T12:00:02Z"),
      },
    ]);

    expect(events).toEqual([
      {
        id: "evt_1",
        state: "pending",
        label: "Started chat run",
        at: "2026-05-18T12:00:00.000Z",
        category: "progress",
      },
      {
        id: "tool_1",
        state: "succeeded",
        label: "Searched GitHub",
        at: "2026-05-18T12:00:02.000Z",
        category: "tools",
      },
    ]);
  });

  it("replays inline tool call and result events as GitHub activity", () => {
    const events = runEventsToActivityEvents([
      {
        id: "evt_call",
        sequence: 1,
        provider: "github",
        toolName: "list_pull_requests",
        eventType: "tool_call",
        status: "pending",
        label: "Searching GitHub...",
        toolCallId: "tool_1",
        input: { state: "open" },
        error: null,
        occurredAt: new Date("2026-05-18T12:00:01Z"),
      },
      {
        id: "evt_result",
        sequence: 2,
        provider: "github",
        toolName: "list_pull_requests",
        eventType: "tool_result",
        status: "succeeded",
        label: "Searched GitHub",
        toolCallId: "tool_1",
        output: [{ number: 237, title: "Fix feedback panel" }],
        error: null,
        occurredAt: new Date("2026-05-18T12:00:02Z"),
      },
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        id: "tool_1",
        state: "succeeded",
        label: "Searched GitHub",
        at: "2026-05-18T12:00:02.000Z",
        category: "github",
        detail: expect.stringContaining("Fix feedback panel"),
      }),
    ]);
  });

  it("maps failed events to user-facing failed activity", () => {
    const events = runEventsToActivityEvents([
      {
        id: "evt_1",
        sequence: 1,
        eventType: "run_failed",
        status: "failed",
        label: "Run failed",
        toolCallId: null,
        error: "Something went wrong",
        occurredAt: new Date("2026-05-18T12:00:00Z"),
      },
    ]);

    expect(events).toEqual([
      {
        id: "evt_1",
        state: "failed",
        label: "Run failed",
        detail: "Something went wrong",
        at: "2026-05-18T12:00:00.000Z",
        category: "progress",
      },
    ]);
  });

  it("marks prior lifecycle events complete when a terminal run event exists", () => {
    const events = runEventsToActivityEvents([
      {
        id: "evt_1",
        sequence: 1,
        eventType: "run_queued",
        status: "pending",
        label: "Queued background chat run",
        toolCallId: null,
        error: null,
        occurredAt: new Date("2026-05-18T12:00:00Z"),
      },
      {
        id: "evt_2",
        sequence: 2,
        eventType: "worker_started",
        status: "pending",
        label: "Background worker started the agent run",
        toolCallId: null,
        error: null,
        occurredAt: new Date("2026-05-18T12:00:01Z"),
      },
      {
        id: "evt_3",
        sequence: 3,
        eventType: "run_completed",
        status: "succeeded",
        label: "Stored assistant answer",
        toolCallId: null,
        error: null,
        occurredAt: new Date("2026-05-18T12:00:02Z"),
      },
    ]);

    expect(events.map((event) => [event.state, event.label])).toEqual([
      ["succeeded", "Queued background chat run"],
      ["succeeded", "Background worker started the agent run"],
      ["succeeded", "Stored assistant answer"],
    ]);
  });

  it("turns context-pack events into a visible Vault receipt", () => {
    const events = runEventsToActivityEvents([
      {
        id: "evt_context",
        sequence: 1,
        eventType: "context_pack_assembled",
        status: "succeeded",
        label: "Assembled context pack",
        toolCallId: null,
        error: null,
        metadata: {
          contextReceipt: {
            vault: {
              checked: true,
              injected: true,
              approvedMemoryItems: 2,
              approvedMemoryChars: 128,
            },
            work: {
              artifactContextInjected: true,
              uploadedFilesInjected: false,
            },
            tools: { mounted: ["github"] },
            contextItems: [
              {
                source: "user_memory_items.approved",
                injected: true,
              },
              {
                source: "workspace_artifacts",
                injected: true,
              },
            ],
          },
        },
        occurredAt: new Date("2026-05-18T12:00:00Z"),
      },
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        id: "evt_context",
        state: "succeeded",
        label: "Checked Vault · 2 approved memories",
        category: "context",
        detail: expect.stringContaining("Vault checked: 2 approved memories"),
      }),
    ]);
    expect(events[0]?.detail).toContain("mounted tools: github");
    expect(events[0]?.detail).toContain("workspace_artifacts 1/1");
  });
});

/**
 * #443 — read-max-then-insert can race under dual writers; the
 * run_events (run_id, sequence) unique index turns the race into a 23505
 * and the append helpers re-read the max and retry.
 */
describe("sequence allocation retry (#443)", () => {
  function sequenceDb({
    maxes,
    insertErrors = [],
  }: {
    /** Max sequence returned by each successive read (last value repeats). */
    maxes: number[];
    /** Errors thrown by successive inserts before inserts start succeeding. */
    insertErrors?: unknown[];
  }) {
    const inserted: Array<Record<string, unknown>> = [];
    let reads = 0;
    let inserts = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                const max = maxes[Math.min(reads, maxes.length - 1)]!;
                reads += 1;
                return max === 0 ? [] : [{ sequence: max }];
              },
            }),
          }),
        }),
      }),
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          const error = insertErrors[inserts];
          inserts += 1;
          if (error !== undefined) throw error;
          inserted.push(values);
        },
      }),
    } as unknown as Database;
    return { db, inserted, counts: () => ({ reads, inserts }) };
  }

  function uniqueViolation(): Error {
    const err = new Error(
      'duplicate key value violates unique constraint "run_events_run_sequence_unique_idx"',
    );
    (err as Error & { code: string }).code = "23505";
    return err;
  }

  const baseInput = {
    runId: "run-1",
    eventType: "run_started",
    label: "Started",
  };

  it("re-reads the max and retries after a unique violation", async () => {
    const { db, inserted, counts } = sequenceDb({
      maxes: [4, 5],
      insertErrors: [uniqueViolation()],
    });

    await appendRunEventWithNextSequence({ ...baseInput, db });

    expect(counts()).toEqual({ reads: 2, inserts: 2 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ runId: "run-1", sequence: 6 });
  });

  it("retries a drizzle-wrapped violation found on the cause chain", async () => {
    const { db, inserted } = sequenceDb({
      maxes: [0, 1],
      insertErrors: [new Error("query failed", { cause: uniqueViolation() })],
    });

    await appendRunEventWithNextSequence({ ...baseInput, db });

    expect(inserted[0]).toMatchObject({ sequence: 2 });
  });

  it("rethrows non-conflict errors without retrying", async () => {
    const boom = new Error("connection reset");
    const { db, counts } = sequenceDb({ maxes: [1], insertErrors: [boom] });

    await expect(
      appendRunEventWithNextSequence({ ...baseInput, db }),
    ).rejects.toBe(boom);
    expect(counts()).toEqual({ reads: 1, inserts: 1 });
  });

  it("gives up after exhausting its attempts", async () => {
    const { db, counts } = sequenceDb({
      maxes: [1],
      insertErrors: [uniqueViolation(), uniqueViolation(), uniqueViolation()],
    });

    await expect(
      appendRunEventWithNextSequence({ ...baseInput, db }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(counts()).toEqual({ reads: 3, inserts: 3 });
  });

  it("allocates with retry when a tool event omits the sequence", async () => {
    const { db, inserted, counts } = sequenceDb({
      maxes: [7, 8],
      insertErrors: [uniqueViolation()],
    });

    await appendToolCallRunEvent({
      db,
      runId: "run-1",
      call: {
        id: "tool-1",
        name: "github__search",
        provider: "github",
        toolName: "search",
        input: { q: "prs" },
        startedAt: "2026-07-19T00:00:00.000Z",
      },
    });

    expect(counts()).toEqual({ reads: 2, inserts: 2 });
    expect(inserted[0]).toMatchObject({
      runId: "run-1",
      sequence: 9,
      eventType: "tool_call",
      toolCallId: "tool-1",
    });
  });

  it("uses the caller's sequence verbatim when provided", async () => {
    const { db, inserted, counts } = sequenceDb({ maxes: [99] });

    await appendToolCallRunEvent({
      db,
      runId: "run-1",
      sequence: 3,
      call: {
        id: "tool-1",
        name: "github__search",
        provider: "github",
        toolName: "search",
        input: {},
        startedAt: "2026-07-19T00:00:00.000Z",
      },
    });

    expect(counts()).toEqual({ reads: 0, inserts: 1 });
    expect(inserted[0]).toMatchObject({ sequence: 3 });
  });
});

describe("derivePhaseFromRunEvents (#359)", () => {
  const seq = (
    entries: Array<[string, number]>,
  ): Array<{ eventType: string; sequence: number }> =>
    entries.map(([eventType, sequence]) => ({ eventType, sequence }));

  it("later events win and tool activity supersedes planning", async () => {
    const { derivePhaseFromRunEvents } = await import("@/lib/run-events");
    expect(derivePhaseFromRunEvents([])).toBe("starting");
    expect(
      derivePhaseFromRunEvents(
        seq([
          ["run_started", 1],
          ["context_pack_assembled", 2],
        ]),
      ),
    ).toBe("reading");
    expect(
      derivePhaseFromRunEvents(
        seq([
          ["provider_run_started", 3],
          ["tool_call", 4],
        ]),
      ),
    ).toBe("using tools");
    expect(
      derivePhaseFromRunEvents(
        seq([
          ["tool_result", 5],
          ["workspace_artifacts_created", 6],
          ["run_completed", 7],
        ]),
      ),
    ).toBe("done");
  });

  it("ignores trace-lane events entirely", async () => {
    const { derivePhaseFromRunEvents } = await import("@/lib/run-events");
    expect(
      derivePhaseFromRunEvents(
        seq([
          ["context_pack_assembled", 1],
          ["provider_context_snapshot", 2],
          ["provider_reasoning", 3],
          ["provider_response_metadata", 4],
        ]),
      ),
    ).toBe("reading");
  });
});

describe("trace-event filtering in receipts (#359)", () => {
  it("never renders trace rows as activity", async () => {
    const { runEventsToActivityEvents } = await import("@/lib/run-events");
    const events = runEventsToActivityEvents([
      {
        id: "e1",
        sequence: 1,
        eventType: "provider_context_snapshot",
        status: "succeeded",
        label: "Provider context snapshot",
        toolCallId: null,
        error: null,
        occurredAt: new Date("2026-07-18T00:00:00Z"),
      },
      {
        id: "e2",
        sequence: 2,
        eventType: "context_pack_assembled",
        status: "succeeded",
        label: "Context pack assembled",
        toolCallId: null,
        error: null,
        occurredAt: new Date("2026-07-18T00:00:01Z"),
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.label).toContain("context");
  });
});

describe("workspace_artifacts_created labels (#359)", () => {
  const base = {
    id: "e1",
    sequence: 1,
    eventType: "workspace_artifacts_created",
    status: "succeeded" as const,
    label: "Created 1 workspace artifact",
    toolCallId: null,
    error: null,
    occurredAt: new Date("2026-07-18T00:00:00Z"),
  };

  it("renders Edited file · +N −N from structured metadata", async () => {
    const { runEventsToActivityEvents } = await import("@/lib/run-events");
    const [event] = runEventsToActivityEvents([
      {
        ...base,
        metadata: {
          artifacts: [
            {
              filename: "report.html",
              supersedesArtifactId: "prev-1",
              metadata: { lineDelta: { added: 14, removed: 3 } },
            },
          ],
        },
      },
    ]);
    expect(event!.label).toBe("Edited report.html · +14 −3");
  });

  it("renders Created N files and falls back to the stored label", async () => {
    const { runEventsToActivityEvents } = await import("@/lib/run-events");
    const [multi] = runEventsToActivityEvents([
      {
        ...base,
        metadata: {
          artifacts: [{ filename: "a.md" }, { filename: "b.md" }],
        },
      },
    ]);
    expect(multi!.label).toBe("Created 2 files");
    const [fallback] = runEventsToActivityEvents([{ ...base }]);
    expect(fallback!.label).toBe("Created 1 workspace artifact");
  });

  it("marks approximate deltas with ~", async () => {
    const { runEventsToActivityEvents } = await import("@/lib/run-events");
    const [event] = runEventsToActivityEvents([
      {
        ...base,
        metadata: {
          artifacts: [
            {
              filename: "big.html",
              supersedesArtifactId: "prev-1",
              metadata: {
                lineDelta: { added: 100, removed: 90, approximate: true },
              },
            },
          ],
        },
      },
    ]);
    expect(event!.label).toBe("Edited big.html · ~+100 −90");
  });
});

describe("app validation and publish checkpoints (#359)", () => {
  it("renders safe labels, details, categories, and phases", async () => {
    const { derivePhaseFromRunEvents, runEventsToActivityEvents } = await import(
      "@/lib/run-events"
    );
    const events = [
      {
        id: "validation",
        sequence: 1,
        eventType: "app_version_validation_completed",
        status: "succeeded" as const,
        label: "Validated app version",
        toolCallId: null,
        error: null,
        metadata: {
          check: "credential scan",
          appVersionNumber: 4,
          filenames: ["dashboard.html"],
          passed: 1,
          failed: 0,
        },
        occurredAt: new Date("2026-07-18T00:00:00Z"),
      },
      {
        id: "published",
        sequence: 2,
        eventType: "app_version_published",
        status: "succeeded" as const,
        label: "Published Dashboard · version 4",
        toolCallId: null,
        error: null,
        occurredAt: new Date("2026-07-18T00:00:01Z"),
      },
    ];

    expect(runEventsToActivityEvents(events)).toEqual([
      expect.objectContaining({
        label: "Validated app version",
        category: "workspace",
        detail: expect.stringContaining("Check: credential scan"),
      }),
      expect.objectContaining({
        label: "Published Dashboard · version 4",
        category: "workspace",
      }),
    ]);
    expect(derivePhaseFromRunEvents(events)).toBe("publishing");
  });
});
