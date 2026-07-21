import { describe, expect, it } from "vitest";
import { readSseStream } from "@/lib/sse";

/**
 * The client-side half of the chat streaming spine: every SSE consumer in the
 * app funnels through readSseStream, and until now it had zero coverage. The
 * cases that matter are the transport realities — TCP chunk boundaries land
 * anywhere (including mid-token and mid-separator), servers batch events, and
 * a malformed payload must cost one event, not the stream.
 */

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect<T>(res: Response): Promise<T[]> {
  const events: T[] = [];
  for await (const event of readSseStream<T>(res)) events.push(event);
  return events;
}

describe("readSseStream", () => {
  it("parses a simple event", async () => {
    const events = await collect(sseResponse(['data: {"type":"done"}\n\n']));
    expect(events).toEqual([{ type: "done" }]);
  });

  it("reassembles one event split across many chunks, including a split separator", async () => {
    const events = await collect(
      sseResponse([
        "data: {",
        '"type":"text-delta",',
        '"delta":"hel',
        'lo"}',
        "\n", // first half of the separator...
        "\n", // ...second half in its own chunk
      ]),
    );
    expect(events).toEqual([{ type: "text-delta", delta: "hello" }]);
  });

  it("does not split multi-byte UTF-8 characters across chunk boundaries", async () => {
    // "héllo" with the é's two UTF-8 bytes split across reads — the
    // TextDecoder must run in streaming mode or this yields U+FFFD garbage.
    const bytes = new TextEncoder().encode('data: {"delta":"héllo"}\n\n');
    const splitAt = 17; // inside the é (0xC3 0xA9)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
    const events = await collect<{ delta: string }>(new Response(stream));
    expect(events).toEqual([{ delta: "héllo" }]);
  });

  it("yields every event when multiple events arrive in one chunk", async () => {
    const events = await collect(
      sseResponse([
        'data: {"type":"meta","runId":"r1"}\n\ndata: {"type":"text-delta","delta":"a"}\n\ndata: {"type":"done"}\n\n',
      ]),
    );
    expect(events).toEqual([
      { type: "meta", runId: "r1" },
      { type: "text-delta", delta: "a" },
      { type: "done" },
    ]);
  });

  it("skips a malformed JSON payload without killing the rest of the stream", async () => {
    const events = await collect(
      sseResponse([
        'data: {"type":"first"}\n\n',
        "data: {not json at all\n\n",
        'data: {"type":"last"}\n\n',
      ]),
    );
    expect(events).toEqual([{ type: "first" }, { type: "last" }]);
  });

  it("ignores non-data SSE lines (comments, event:, id:) around the payload", async () => {
    const events = await collect(
      sseResponse([
        ': keep-alive\n\nevent: message\nid: 7\ndata: {"type":"done"}\n\n',
      ]),
    );
    expect(events).toEqual([{ type: "done" }]);
  });

  it("drops a trailing partial event that never received its terminator", async () => {
    const events = await collect(
      sseResponse(['data: {"type":"done"}\n\ndata: {"type":"never-terminated"}']),
    );
    expect(events).toEqual([{ type: "done" }]);
  });

  it("throws on a body-less response", async () => {
    const res = new Response(null);
    await expect(async () => {
      for await (const _event of readSseStream(res)) {
        // unreachable
      }
    }).rejects.toThrow("Response has no body");
  });
});
