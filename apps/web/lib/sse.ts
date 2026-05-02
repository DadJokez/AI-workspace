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
