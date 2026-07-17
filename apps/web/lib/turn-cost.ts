import { estimateCostUsd, isValidModelId } from "@ai-workspace/agent/models";

/**
 * Per-turn token & cost meter (#330). Pure formatting over the persisted
 * tokensIn/tokensOut counts and the registry rate card — trust-visible cost
 * in one muted line. tokensIn is "total tokens sent" (uncached + cache
 * reads + cache writes folded in by the runtime). Cache reads bill BELOW
 * standard (~0.1x) and cache writes ABOVE it (~1.25x), so a standard-rate
 * estimate over the folded total is neither a floor nor a ceiling — the
 * label says "~" and claims nothing stronger. An exact split needs
 * per-message cache columns (migration — Rob's call, tracked in #396); the
 * admin run page has the real split meanwhile.
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
  // 999,500+ would otherwise round to "1000k" in the k branch.
  if (count >= 999_500) {
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
