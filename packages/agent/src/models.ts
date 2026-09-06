/**
 * Model registry (metadata half).
 *
 * Describes every model the product can represent: provider, family,
 * capabilities, cost, context window. Any Bedrock model behind the Converse
 * API fits this shape, and so does any model behind Bedrock's
 * OpenAI-compatible Responses API (`invocation: "responses"`, #660) — the
 * `provider` field keeps the door open beyond Anthropic (#300).
 *
 * Enablement is NOT here: which models may serve which purpose/lane lives in
 * the `model_enablement` DB table (admin-editable later, #302), resolved via
 * `apps/web/lib/model-registry.ts`. A model listed here but with no
 * enablement rows is registered-but-disabled everywhere — the required
 * default for unqualified models (#301).
 *
 * Bedrock model IDs use cross-region inference profiles ("us." prefix) so
 * traffic spreads across regions automatically. If your deployment is locked
 * to a single region, swap to the unprefixed provider IDs
 * (`anthropic.claude-*`, `amazon.nova-*`).
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
  "nova-pro",
  "gpt-5-6-terra",
  "gpt-5-6-sol",
  "gpt-5-6-luna",
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

/**
 * How requests reach the model (#797 P1). `converse` is the Bedrock Converse
 * API; `responses` is Bedrock's OpenAI-compatible Responses API
 * (`BedrockResponsesClient`, #660), which the OpenAI GPT entries need because
 * Converse cannot reach them on this endpoint. `RealBedrockClient` dispatches
 * on this field, so a registry entry selects its route by metadata, never by
 * model-id string matching.
 */
export const MODEL_INVOCATIONS = ["converse", "responses"] as const;
export type ModelInvocation = (typeof MODEL_INVOCATIONS)[number];

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
  /** Prompt-cache input rate relative to normal input. */
  cacheReadInputMultiplier: number;
  /** Prompt-cache write rate relative to normal input. */
  cacheWriteInputMultiplier: number;
  supportsToolUse: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
  /**
   * Whether the provider honors Bedrock `cachePoint` blocks. Anthropic models
   * do; most other Converse models reject them as a validation error or
   * silently ignore them. Every cache-checkpoint emission in
   * `packages/agent/src/clients.ts` is gated on this flag — a model that
   * cannot cache still gets the stable-prefix / volatile-suffix layering
   * (ADR 0010), just without the checkpoints.
   */
  supportsPromptCaching: boolean;
  /** Invocation route for this model; see `ModelInvocation`. */
  invocation: ModelInvocation;
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
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: true,
    invocation: "converse",
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
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: true,
    invocation: "converse",
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
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: true,
    invocation: "converse",
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
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: true,
    invocation: "converse",
    contextWindow: 200_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "multi-step planning",
      "hard reasoning",
      "authoring or refining recipe prompts",
    ],
  },
  /**
   * First non-Claude Converse brain (#797 P3). Registered so it can be
   * qualified (`pnpm eval --model nova-pro`); it has no `model_enablement`
   * rows, so it is disabled for every purpose until Rob writes them.
   *
   * Verified 2026-09-05 (read-only, account 351478076796, us-east-1):
   * `aws bedrock list-inference-profiles` → `us.amazon.nova-pro-v1:0` ACTIVE
   * (SYSTEM_DEFINED), backing `amazon.nova-pro-v1:0` (ON_DEMAND +
   * INFERENCE_PROFILE; text/image/video in, text out, streaming). Context
   * window and the 10k output ceiling come from the Nova user guide's model
   * specifications table.
   *
   * PRICING UNVERIFIED — Rob to confirm. The Bedrock pricing page renders its
   * tables client-side and could not be read on 2026-09-05; third-party
   * mirrors agree on $0.80 / $3.20 per 1M list (cache reads at 75% off).
   * The figures below apply the us.* +10% convention above to those list
   * prices. Cache multipliers are moot while `supportsPromptCaching` is
   * false: the Bedrock prompt-caching guide lists no Nova model in its
   * explicit `cachePoint` table (Nova has implicit prefix caching only), so
   * no checkpoints are emitted — the ADR 0010 stable-prefix layering still
   * helps the implicit cache.
   */
  "nova-pro": {
    id: "nova-pro",
    bedrockModelId: "us.amazon.nova-pro-v1:0",
    provider: "amazon",
    family: "nova",
    displayName: "Nova Pro",
    brandedName: "Nova Pro",
    providerDisplayName: "Amazon",
    blurb: "Amazon's multimodal workhorse. Low cost, independent quota.",
    costPer1MInput: 0.88,
    costPer1MOutput: 3.52,
    cacheReadInputMultiplier: 0.25,
    cacheWriteInputMultiplier: 1,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: false,
    invocation: "converse",
    contextWindow: 300_000,
    // Documented ceiling is 10k output tokens — below the 20–30k a full
    // artifact build needs (#320). The qualification scorecard, not this
    // entry, decides whether that disqualifies it for artifact-heavy lanes.
    defaultMaxTokens: 10_000,
    recommendedFor: [
      "cost-sensitive chat and summarization",
      "image and document understanding",
      "quota-independent capacity once qualified",
    ],
  },
  /**
   * OpenAI GPT-5.6 on Bedrock (#660, #797 P4) — the first `responses`-route
   * entries. Served through Bedrock's OpenAI-compatible Responses API on the
   * `bedrock-runtime` endpoint (`BedrockResponsesClient`); Converse cannot
   * reach them there. No `model_enablement` rows: disabled for every purpose
   * until qualified and flipped by Rob. Three entries share one comment.
   *
   * Verified 2026-09-06 (read-only, account 351478076796, us-east-1):
   * `aws bedrock get-foundation-model` → `openai.gpt-5.6-terra` ACTIVE,
   * text+image in, text out, streaming, INFERENCE_PROFILE only;
   * `list-inference-profiles` → `us.openai.gpt-5.6-{terra,sol,luna}` ACTIVE
   * (SYSTEM_DEFINED). The `us.` geo profile is required on this endpoint
   * (in-Region is Mantle-only) and keeps US residency like the Claude entries.
   * Model ACCESS is not granted yet: `get-foundation-model-availability`
   * reports IAM AUTHORIZED, entitlement and region AVAILABLE, but
   * `agreementAvailability: NOT_AVAILABLE` for all three — the OpenAI
   * third-party model agreement has not been accepted in this account
   * (Bedrock console → Model access; Rob). Until then every request is a
   * 403 "not available for this account" and nothing can be qualified.
   *
   * Pricing is read from each model card's "Geo CRIS, Short Context Window
   * (272K)" row — already the regional rate (Global CRIS is 10% lower), so
   * no +10% is applied on top. Beyond 272K input tokens Bedrock bills the
   * "Long Context" tier at 2×; `contextWindow` declares the short tier the
   * registry prices at, not the card's 1M, so cost accounting stays truthful
   * (the loop's context lifecycle keeps transcripts far below it). Cache
   * multipliers are the card's cache-read / cache-write columns (0.1× /
   * 1.25×); `supportsPromptCaching` is false because that flag gates Converse
   * `cachePoint` blocks and the Responses client sends no explicit cache
   * markers in phase 1 — Bedrock's implicit caching still applies and the
   * usage block's `cached_tokens` are counted at the cache-read rate.
   * Output ceiling UNVERIFIED on the card; 32k matches the Claude entries and
   * the artifact-build need (#320).
   */
  "gpt-5-6-terra": {
    id: "gpt-5-6-terra",
    bedrockModelId: "us.openai.gpt-5.6-terra",
    provider: "openai",
    family: "gpt",
    displayName: "GPT-5.6 Terra",
    brandedName: "GPT-5.6 Terra",
    providerDisplayName: "OpenAI",
    olderModelExample: "GPT-4",
    blurb: "OpenAI's balanced production model. Code, content, extraction, agentic work.",
    costPer1MInput: 2.2,
    costPer1MOutput: 13.2,
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: false,
    invocation: "responses",
    contextWindow: 272_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "general chat and writing",
      "code generation and structured extraction",
      "provider-independent capacity once qualified",
    ],
  },
  "gpt-5-6-sol": {
    id: "gpt-5-6-sol",
    bedrockModelId: "us.openai.gpt-5.6-sol",
    provider: "openai",
    family: "gpt",
    displayName: "GPT-5.6 Sol",
    brandedName: "GPT-5.6 Sol",
    providerDisplayName: "OpenAI",
    olderModelExample: "GPT-4",
    blurb: "OpenAI's most capable model. Frontier reasoning and agentic work.",
    costPer1MInput: 4.4,
    costPer1MOutput: 22,
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: false,
    invocation: "responses",
    contextWindow: 272_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "multi-step planning",
      "hard reasoning",
      "provider-independent capacity once qualified",
    ],
  },
  "gpt-5-6-luna": {
    id: "gpt-5-6-luna",
    bedrockModelId: "us.openai.gpt-5.6-luna",
    provider: "openai",
    family: "gpt",
    displayName: "GPT-5.6 Luna",
    brandedName: "GPT-5.6 Luna",
    providerDisplayName: "OpenAI",
    olderModelExample: "GPT-4",
    blurb: "OpenAI's fast, affordable model. Classification, summarization, routing.",
    costPer1MInput: 0.22,
    costPer1MOutput: 1.32,
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: false,
    invocation: "responses",
    contextWindow: 272_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "quick lookups",
      "classification / routing",
      "cost-sensitive summarization once qualified",
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

/**
 * Cache-aware provider cost for one usage event. The registry owns each
 * model's billing multipliers so budget enforcement stays provider-portable.
 */
export function estimateUsageCostUsd(
  modelId: ModelId,
  usage: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
    tokensOut: number;
  },
): number {
  const model = MODELS[modelId];
  return (
    (usage.inputTokens / 1_000_000) * model.costPer1MInput +
    (usage.cacheReadInputTokens / 1_000_000) *
      model.costPer1MInput *
      model.cacheReadInputMultiplier +
    (usage.cacheWriteInputTokens / 1_000_000) *
      model.costPer1MInput *
      model.cacheWriteInputMultiplier +
    (usage.tokensOut / 1_000_000) * model.costPer1MOutput
  );
}
