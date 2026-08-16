import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createChatStreamWriter,
  startChatStreamHeartbeat,
  type ChatStreamEvent,
} from "@/lib/chat-stream-contract";

afterEach(() => {
  vi.useRealTimers();
});

describe("chat stream server contract (#465)", () => {
  it("allows exactly one terminal event and nothing after it", () => {
    const events: ChatStreamEvent[] = [];
    const writer = createChatStreamWriter((event) => events.push(event));

    writer.send({
      type: "heartbeat",
      at: "2026-07-23T00:00:00.000Z",
    });
    writer.send({ type: "done", stopReason: "completed" });

    expect(writer.hasTerminal()).toBe(true);
    expect(() =>
      writer.send({
        type: "heartbeat",
        at: "2026-07-23T00:00:15.000Z",
      }),
    ).toThrow(/after its terminal event/);
    expect(events.map((event) => event.type)).toEqual(["heartbeat", "done"]);
  });

  it("emits transport heartbeats while a non-terminal stream is quiet", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const stop = startChatStreamHeartbeat(send, {
      intervalMs: 1_000,
      now: () => new Date("2026-07-23T00:00:00.000Z"),
    });

    vi.advanceTimersByTime(2_000);
    stop();
    vi.advanceTimersByTime(2_000);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({
      type: "heartbeat",
      at: "2026-07-23T00:00:00.000Z",
    });
  });

  it("treats an approval wait as a successful terminal handoff", () => {
    const writer = createChatStreamWriter(() => undefined);
    writer.send({ type: "done", stopReason: "approval_required" });
    expect(writer.hasTerminal()).toBe(true);
  });
});
