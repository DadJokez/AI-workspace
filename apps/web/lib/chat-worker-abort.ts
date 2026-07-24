export const CHAT_WORKER_ABORT_REASONS = [
  "timeout",
  "lease_lost",
  "shutdown",
  "canceled",
] as const;

export type ChatWorkerAbortReason =
  (typeof CHAT_WORKER_ABORT_REASONS)[number];

interface ChatWorkerAbortSignalReason {
  kind: "chat_worker_abort";
  reason: ChatWorkerAbortReason;
}

/**
 * AbortController keeps the first reason it receives, which preserves the
 * source that actually stopped a worker when timeout, shutdown, and lease
 * callbacks race.
 */
export function abortChatWorkerRuntime(
  controller: AbortController,
  reason: ChatWorkerAbortReason,
): boolean {
  if (controller.signal.aborted) return false;
  controller.abort({
    kind: "chat_worker_abort",
    reason,
  } satisfies ChatWorkerAbortSignalReason);
  return true;
}

export function chatWorkerAbortReason(
  signal: AbortSignal,
): ChatWorkerAbortReason | null {
  const value = signal.reason;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { kind?: unknown }).kind !== "chat_worker_abort"
  ) {
    return null;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" &&
    (CHAT_WORKER_ABORT_REASONS as readonly string[]).includes(reason)
    ? (reason as ChatWorkerAbortReason)
    : null;
}
