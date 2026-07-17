import { estimateCostUsd, isValidModelId } from "@ai-workspace/agent/models";

/**
 * Per-turn token & cost meter (#330). Pure formatting over the persisted
 * tokensIn/tokensOut counts and the registry rate card — trust-visible cost
 * in one muted line. tokensIn is "total tokens sent" (uncached + cache
 * reads/writes folded in by the runtime), so the estimate is an upper bound
 * at standard rates; the run detail page has the cached/uncached split.
 */
export function formatTurnMeter(
  modelId: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
): string | null {
  const input = typeof tokensIn === "number" && tokensIn > 0 ? tokensIn : 0;
  const output = typeof tokensOut === "number" && tokensOut > 0 ? tokensOut : 0;
  const total = input + output;
  if (total === 0) return null;

  const tokens = `${formatTokenCount(total)} tokens`;
  if (!modelId || !isValidModelId(modelId)) return tokens;

  const cost = estimateCostUsd(modelId, input, output);
  if (cost < 0.005) return `${tokens} · <$0.01`;
  return `${tokens} · ~$${cost.toFixed(2)}`;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${trimTrailingZero((count / 1_000_000).toFixed(1))}M`;
  }
  if (count >= 1_000) {
    return `${trimTrailingZero((count / 1_000).toFixed(1))}k`;
  }
  return String(count);
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}
