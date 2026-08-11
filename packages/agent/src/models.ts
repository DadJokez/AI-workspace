/**
 * Model registry (metadata half).
 *
 * Describes every model the product can represent: provider, family,
 * capabilities, cost, context window. Any Bedrock model behind the converse
 * API fits this shape — the `provider` field keeps the door open beyond
 * Anthropic without implementing anything else yet (#300).
 *
 * Enablement is NOT here: which models may serve which purpose/lane lives in
 * the `model_enablement` DB table (admin-editable later, #302), resolved via
 * `apps/web/lib/model-registry.ts`. A model listed here but with no
 * enablement rows is registered-but-disabled everywhere — the required
 * default for unqualified models (#301).
 *
 * Bedrock model IDs use cross-region inference profiles ("us." prefix) so
 * traffic spreads across regions automatically. If your deployment is locked
 * to a single region, swap to the unprefixed `anthropic.claude-*` IDs.
 *
 * NOTE: verify the exact `bedrockModelId` strings against your Bedrock console
 * (Model access page) before first deploy — providers occasionally publish
 * new dated revisions.
 */

export const MODEL_IDS = [
  "haiku-4-5",
  "sonnet-4-5",
  "sonnet-4-6",
  "opus-4-7",
] as const;
export type ModelId = (typeof MODEL_IDS)[number];

/**
 * Everything that resolves a model does so for one of these purposes. The
 * first three are the chat runtime lanes (`ChatRuntimeLane`); the rest are
 * internal consumers. Enablement is persisted per (model, purpose).
 */
export const MODEL_PURPOSES = [
  /** User-facing selection: /model command, skill pinning, default prefs. */
  "chat",
  "fast-local",
  "tool-local",
  "durable-local",
  /** Thread titles + rolling summaries. */
  "summaries",
  /** Routing/classification calls (autopilot stays heuristic today). */
  "routing",
  /** Vault memory-capture reviewer. */
  "memory-capture",
] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export interface ModelMetadata {
  id: ModelId;
  bedrockModelId: string;
  /** Who makes the model (e.g. "anthropic", "amazon", "meta", "mistral"). */
  provider: string;
  /** Model family within the provider (e.g. "claude", "nova", "llama"). */
  family: string;
  displayName: string;
  /**
   * Identity-honesty fields (#797 P1). The runtime-injected identity line is
   * built ONLY from these — durable/prompt text must never hardcode a vendor
   * (#304). `brandedName` is the full name the assistant answers with when
   * asked what model it is; `providerDisplayName` is the vendor's brand name
   * (capitalizing `provider` breaks on e.g. "openai" → "OpenAI").
   */
  brandedName: string;
  providerDisplayName: string;
  /**
   * Optional older-model name this family is known to misclaim from training
   * priors (Claude models answered "Claude 3.5" — the original identity bug).
   * When set, the identity line names it as the explicit anti-example.
   */
  olderModelExample?: string;
  blurb: string;
  /** USD per 1M input tokens */
  costPer1MInput: number;
  /** USD per 1M output tokens */
  costPer1MOutput: number;
  supportsToolUse: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  contextWindow: number;
  /**
   * Per-turn output cap passed to Converse. Must leave room for a complete
   * artifact — a full HTML app runs 20–30K output tokens, and 8192 truncated
   * every app build mid-file (issue #320). Every lane streams, so large caps
   * don't risk request timeouts. Keep each registry value at or below the
   * selected Bedrock model's documented output ceiling.
   */
  defaultMaxTokens: number;
  /** Suggested use cases — surfaced in the model selector tooltip. */
  recommendedFor: readonly string[];
}

/**
 * Cost figures are us.* geo cross-region inference-profile rates (deliberate
 * US-residency choice): Bedrock list + the 10% regional-endpoint premium, as
 * of July 2026 — not global-endpoint list prices. Keep in sync with what the
 * account actually pays; router-lane selection (#303) and cost displays read
 * these fields.
 */
export const MODELS: Record<ModelId, ModelMetadata> = {
  "haiku-4-5": {
    id: "haiku-4-5",
    bedrockModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    provider: "anthropic",
    family: "claude",
    displayName: "Haiku 4.5",
    brandedName: "Claude Haiku 4.5",
    providerDisplayName: "Anthropic",
    olderModelExample: "Claude 3.5",
    blurb: "Fast and cheap. Routing, classification, simple Q&A.",
    costPer1MInput: 1.1,
    costPer1MOutput: 5.5,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    contextWindow: 200_000,
    defaultMaxTokens: 16_000,
    recommendedFor: [
      "quick lookups",
      "classification / routing",
      "tight loops where latency matters",
    ],
  },
  "sonnet-4-5": {
    id: "sonnet-4-5",
    bedrockModelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    provider: "anthropic",
    family: "claude",
    displayName: "Sonnet 4.5",
    brandedName: "Claude Sonnet 4.5",
    providerDisplayName: "Anthropic",
    olderModelExample: "Claude 3.5",
    blurb: "Balanced agent model for chat, writing, analysis, and tool use.",
    costPer1MInput: 3.3,
    costPer1MOutput: 16.5,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    contextWindow: 200_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "general chat",
      "writing and analysis",
      "everyday tool use",
    ],
  },
  "sonnet-4-6": {
    id: "sonnet-4-6",
    bedrockModelId: "us.anthropic.claude-sonnet-4-6",
    provider: "anthropic",
    family: "claude",
    displayName: "Sonnet 4.6",
    brandedName: "Claude Sonnet 4.6",
    providerDisplayName: "Anthropic",
    olderModelExample: "Claude 3.5",
    blurb: "Balanced default. Most chat, recipes, and tool use.",
    costPer1MInput: 3.3,
    costPer1MOutput: 16.5,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    contextWindow: 200_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "general chat",
      "recipe execution",
      "everyday tool use",
    ],
  },
  "opus-4-7": {
    id: "opus-4-7",
    bedrockModelId: "us.anthropic.claude-opus-4-7",
    provider: "anthropic",
    family: "claude",
    displayName: "Opus 4.7",
    brandedName: "Claude Opus 4.7",
    providerDisplayName: "Anthropic",
    olderModelExample: "Claude 3.5",
    blurb: "Heavy reasoning. Planning, complex analysis, recipe authoring.",
    costPer1MInput: 5.5,
    costPer1MOutput: 27.5,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    contextWindow: 200_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "multi-step planning",
      "hard reasoning",
      "authoring or refining recipe prompts",
    ],
  },
};

/**
 * Temporary account-wide model pin while the Sonnet 4.6 daily-token quota
 * increase is pending. Keeping this separate from the default lets us remove
 * the pin later without rewriting stored thread, user, or skill preferences.
 */
export const PLATFORM_MODEL_OVERRIDE_ID: ModelId | null = "sonnet-4-5";

export const DEFAULT_MODEL_ID: ModelId =
  PLATFORM_MODEL_OVERRIDE_ID ?? "sonnet-4-6";

export function getModel(id: ModelId): ModelMetadata {
  return MODELS[id];
}

export function isValidModelId(s: string): s is ModelId {
  return (MODEL_IDS as readonly string[]).includes(s);
}

export function isValidModelPurpose(s: string): s is ModelPurpose {
  return (MODEL_PURPOSES as readonly string[]).includes(s);
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
