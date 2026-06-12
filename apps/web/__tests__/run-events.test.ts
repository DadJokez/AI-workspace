import { describe, expect, it } from "vitest";
import { runEventsToActivityEvents } from "@/lib/run-events";

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
});
