import {
  isChatStreamEventType,
  isChatStreamTerminalEvent,
  type ChatStreamEvent,
} from "@/lib/chat-stream-contract";

/**
 * Generic SSE-reader for `fetch` responses.
 *
 * Yields one parsed object per `data: ...\n\n` event. The server is expected
 * to JSON-encode each event payload; non-JSON events are skipped silently.
 */
export async function* readSseStream<T = unknown>(
  res: Response,
): AsyncGenerator<T, void, void> {
  if (!res.body) {
    throw new Error("Response has no body");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLine = event
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (dataLine) {
          const payload = dataLine.slice(6);
          try {
            yield JSON.parse(payload) as T;
          } catch {
            // ignore malformed event
          }
        }

        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Chat streams are complete only after one final done/failed event. A clean
 * HTTP EOF is not evidence that the model completed; missing or non-final
 * terminal frames are surfaced as protocol failures so partial answers never
 * look successful in the client.
 */
export async function* readChatSseStream(
  res: Response,
): AsyncGenerator<ChatStreamEvent, void, void> {
  let terminalSeen = false;

  for await (const value of readSseStream<unknown>(res)) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("type" in value) ||
      typeof value.type !== "string"
    ) {
      throw new ChatStreamProtocolError(
        "Chat stream emitted an event without a valid type.",
      );
    }
    if (!isChatStreamEventType(value.type)) {
      throw new ChatStreamProtocolError(
        `Chat stream emitted an unknown ${value.type} event.`,
      );
    }
    if (
      (value.type === "done" || value.type === "failed") &&
      !isChatStreamTerminalEvent(value)
    ) {
      throw new ChatStreamProtocolError(
        `Chat stream emitted an invalid ${value.type} terminal event.`,
      );
    }
    const event = value as ChatStreamEvent;
    if (terminalSeen) {
      throw new ChatStreamProtocolError(
        `Chat stream emitted ${event.type} after its terminal event.`,
      );
    }
    if (isChatStreamTerminalEvent(event)) terminalSeen = true;
    yield event;
  }

  if (!terminalSeen) {
    throw new ChatStreamProtocolError(
      "Chat stream ended before a terminal event. The response may be incomplete.",
    );
  }
}

export class ChatStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatStreamProtocolError";
  }
}
