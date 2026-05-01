/**
 * Model registry.
 *
 * Three Claude models are enabled day one. Selectable per chat thread and per
 * recipe — right tool for the job, cost-conscious story for IT.
 *
 * Bedrock model IDs use cross-region inference profiles ("us." prefix) so
 * traffic spreads across regions automatically. If your deployment is locked
 * to a single region, swap to the unprefixed `anthropic.claude-*` IDs.
 *
 * NOTE: verify the exact `bedrockModelId` strings against your Bedrock console
 * (Model access page) before first deploy — Anthropic occasionally publishes
 * new dated revisions.
 */

export const MODEL_IDS = ["haiku-4-5", "sonnet-4-6", "opus-4-7"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export interface ModelMetadata {
  id: ModelId;
  bedrockModelId: string;
  displayName: string;
  blurb: string;
  /** USD per 1M input tokens */
  costPer1MInput: number;
  /** USD per 1M output tokens */
  costPer1MOutput: number;
  supportsToolUse: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  defaultMaxTokens: number;
  /** Suggested use cases — surfaced in the model selector tooltip. */
  recommendedFor: readonly string[];
}

export const MODELS: Record<ModelId, ModelMetadata> = {
  "haiku-4-5": {
    id: "haiku-4-5",
    bedrockModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    displayName: "Haiku 4.5",
    blurb: "Fast and cheap. Routing, classification, simple Q&A.",
    costPer1MInput: 0.8,
    costPer1MOutput: 4,
    supportsToolUse: true,
    supportsStreaming: true,
    contextWindow: 200_000,
    defaultMaxTokens: 4096,
    recommendedFor: [
      "quick lookups",
      "classification / routing",
      "tight loops where latency matters",
    ],
  },
  "sonnet-4-6": {
    id: "sonnet-4-6",
    bedrockModelId: "us.anthropic.claude-sonnet-4-6-v1:0",
    displayName: "Sonnet 4.6",
    blurb: "Balanced default. Most chat, recipes, and tool use.",
    costPer1MInput: 3,
    costPer1MOutput: 15,
    supportsToolUse: true,
    supportsStreaming: true,
    contextWindow: 200_000,
    defaultMaxTokens: 8192,
    recommendedFor: [
      "general chat",
      "recipe execution",
      "everyday tool use",
    ],
  },
  "opus-4-7": {
    id: "opus-4-7",
    bedrockModelId: "us.anthropic.claude-opus-4-7-v1:0",
    displayName: "Opus 4.7",
    blurb: "Heavy reasoning. Planning, complex analysis, recipe authoring.",
    costPer1MInput: 15,
    costPer1MOutput: 75,
    supportsToolUse: true,
    supportsStreaming: true,
    contextWindow: 200_000,
    defaultMaxTokens: 8192,
    recommendedFor: [
      "multi-step planning",
      "hard reasoning",
      "authoring or refining recipe prompts",
    ],
  },
};

export const DEFAULT_MODEL_ID: ModelId = "sonnet-4-6";

export function getModel(id: ModelId): ModelMetadata {
  return MODELS[id];
}

export function isValidModelId(s: string): s is ModelId {
  return (MODEL_IDS as readonly string[]).includes(s);
}

/**
 * Compute USD cost for a completion given token counts.
 * Returns dollars (not micros). Persist as `cost_usd_micros = round(cost * 1_000_000)`.
 */
export function estimateCostUsd(
  modelId: ModelId,
  tokensIn: number,
  tokensOut: number,
): number {
  const m = MODELS[modelId];
  return (
    (tokensIn / 1_000_000) * m.costPer1MInput +
    (tokensOut / 1_000_000) * m.costPer1MOutput
  );
}
