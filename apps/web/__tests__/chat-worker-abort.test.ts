import { describe, expect, it } from "vitest";
import {
  abortChatWorkerRuntime,
  chatWorkerAbortReason,
  CHAT_WORKER_ABORT_REASONS,
} from "@/lib/chat-worker-abort";

describe("chat worker abort reasons", () => {
  it.each(CHAT_WORKER_ABORT_REASONS)(
    "carries the %s reason on the native AbortSignal",
    (reason) => {
      const controller = new AbortController();

      expect(abortChatWorkerRuntime(controller, reason)).toBe(true);

      expect(controller.signal.aborted).toBe(true);
      expect(chatWorkerAbortReason(controller.signal)).toBe(reason);
    },
  );

  it("keeps the first source when abort callbacks race", () => {
    const controller = new AbortController();

    expect(abortChatWorkerRuntime(controller, "shutdown")).toBe(true);
    expect(abortChatWorkerRuntime(controller, "timeout")).toBe(false);

    expect(chatWorkerAbortReason(controller.signal)).toBe("shutdown");
  });

  it("does not mistake an untyped browser abort for a worker reason", () => {
    const controller = new AbortController();
    controller.abort();

    expect(chatWorkerAbortReason(controller.signal)).toBeNull();
  });
});
