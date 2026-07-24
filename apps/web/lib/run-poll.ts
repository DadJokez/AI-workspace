/**
 * #447: decision logic for the pending-run poll.
 *
 * While a background run placeholder is visible, the chat client polls the
 * slim `GET /api/runs/[id]/status` endpoint every 500ms and reloads the full
 * thread (messages + run events + artifact content) only when this module
 * says the run actually moved. Client-safe: no server imports.
 */

/** Wire shape of GET /api/runs/[id]/status. */
export interface RunStatusResponse {
  run: {
    id: string;
    status: string;
    updatedAt: string;
    /** Highest run_events.sequence for the run; null before the first event. */
    latestEventSequence: number | null;
    /** Safe aggregate only; the full usage breakdown remains server-side. */
    liveTokens?: number | null;
  };
}

/** The cheap cursor the poll compares between ticks. */
export interface RunStatusSnapshot {
  status: string;
  latestEventSequence: number | null;
}

/**
 * Extract the aggregate token count from a persisted run output without
 * trusting arbitrary JSON. Worker outputs carry both the canonical usage
 * object and legacy top-level counters; either shape can reconstruct the
 * live footer after a refresh.
 */
export function liveTokenTotalFromRunOutput(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const usage = isRecord(value.usage) ? value.usage : null;
  const tokensIn =
    tokenCount(usage?.tokensIn) ?? tokenCount(value.tokensIn);
  const tokensOut =
    tokenCount(usage?.tokensOut) ?? tokenCount(value.tokensOut);
  if (tokensIn === null && tokensOut === null) return null;
  return (tokensIn ?? 0) + (tokensOut ?? 0);
}

/**
 * Anything outside queued/running is terminal — mirrors the loader, which
 * only renders `pending` placeholders for queued/running runs.
 */
export function isTerminalRunStatus(status: string): boolean {
  return status !== "queued" && status !== "running";
}

/**
 * Reload the full thread when:
 * - the run reached a terminal status (the assistant message or failure note
 *   is ready, even if no event advanced), or
 * - this is the first slim tick (no cursor yet — reload once so nothing that
 *   landed between the initial hydrate and the first poll is missed), or
 * - the status or the event-sequence cursor moved since the last tick.
 */
export function shouldReloadThread(
  previous: RunStatusSnapshot | null,
  current: RunStatusSnapshot,
): boolean {
  if (isTerminalRunStatus(current.status)) return true;
  if (!previous) return true;
  return (
    current.status !== previous.status ||
    (current.latestEventSequence ?? -1) !==
      (previous.latestEventSequence ?? -1)
  );
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
