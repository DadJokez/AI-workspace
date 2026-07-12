import type { TokenUsage } from "@ai-workspace/agent";

type RuntimeUsageEvent = Pick<TokenUsage, "tokensIn" | "tokensOut"> &
  Partial<
    Pick<
      TokenUsage,
      "inputTokens" | "cacheReadInputTokens" | "cacheWriteInputTokens"
    >
  >;

/** Preserve cache billing classes while accepting older runtime usage events. */
export function normalizeRuntimeUsage(event: RuntimeUsageEvent): TokenUsage {
  return {
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    inputTokens: event.inputTokens ?? event.tokensIn,
    cacheReadInputTokens: event.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: event.cacheWriteInputTokens ?? 0,
  };
}
