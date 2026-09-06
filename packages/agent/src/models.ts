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
 * to a single region, swap to the unprefixed provider IDs
 * (`anthropic.claude-*`, `amazon.nova-*`). Models Bedrock offers only as an
 * in-region ON_DEMAND id with no geo profile (the Qwen / Kimi / GLM /
 * Nemotron / DeepSeek entries) declare that bare id.
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
  // 2026-09-06 gaggle (#797 P5); older before newer within a vendor so a
  // shared `/model` short name resolves to the newest.
  "qwen3-32b",
  "qwen3-next-80b",
  "kimi-k2-5",
  "glm-4-7",
  "glm-5",
  "nemotron-super-3-120b",
  "deepseek-v3-2",
  "sonnet-5",
  "opus-5",
  "fable-5-1",
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
 * API — the only route implemented today (`RealBedrockClient`). `responses`
 * is reserved for the Bedrock Mantle / Responses-shaped adapter (#660);
 * nothing dispatches on it yet, but every registry entry declares its route
 * so the adapter that lands behind it can select by metadata instead of by
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
   * 2026-09-06 gaggle (#797 P5 rehearsal): ten more Converse brains,
   * registered so `pnpm eval --model <id>` can score them. None has a
   * `model_enablement` row, so every one is disabled for every purpose until
   * Rob writes rows; the scorecards are in
   * `docs/models/QUALIFICATION_2026-09-06.md`.
   *
   * Verified read-only 2026-09-06 (account 351478076796, us-east-1) with
   * `aws bedrock get-foundation-model` + `list-inference-profiles`: the seven
   * non-Anthropic models are ON_DEMAND in-region ids with no geo (`us.`)
   * profile, so the bare id is declared and list price applies (no +10%
   * regional-endpoint premium); the three Claude 5.x models are
   * INFERENCE_PROFILE-only and declare their ACTIVE `us.` profile. Context
   * windows and output ceilings are the Bedrock model cards' figures.
   *
   * Prompt caching: only the three Claude entries appear in the Bedrock
   * prompt-caching guide's explicit `cachePoint` table (Fable 5.1 / Opus 5:
   * 512-token minimum; Sonnet 5: 1,024). A `cachePoint` probe on each of the
   * other seven returned AccessDeniedException "did not allow prompt
   * caching", so `supportsPromptCaching` is false for them, the loop emits
   * no checkpoints, and their cache multipliers are moot (set to 1).
   *
   * Pricing: the AWS Price List bulk API (us-east-1, 2026-09-01 publication)
   * where the model is listed — Kimi K2.5, GLM 4.7, GLM 5, DeepSeek V3.2.
   * Qwen3 32B, Qwen3 Next 80B and Nemotron 3 Super are not in that file;
   * their figures are third-party calculators and marked UNVERIFIED — Rob to
   * confirm. The Claude 5.x entries are AWS Marketplace-billed and absent
   * from the Price List too; their figures are Anthropic's first-party list
   * plus the us.* +10% convention (Sonnet 5 2.20/11 matches the accepted
   * Marketplace agreement) and are likewise UNVERIFIED on the Bedrock side.
   */
  "qwen3-32b": {
    id: "qwen3-32b",
    bedrockModelId: "qwen.qwen3-32b-v1:0",
    provider: "alibaba",
    family: "qwen3",
    displayName: "Qwen3 32B",
    brandedName: "Qwen3 32B",
    providerDisplayName: "Alibaba Cloud",
    blurb: "Dense 32B Qwen3. Cheapest candidate; 32k context only.",
    // PRICING UNVERIFIED — Rob to confirm (third-party: $0.15 / $0.60 list).
    costPer1MInput: 0.15,
    costPer1MOutput: 0.6,
    cacheReadInputMultiplier: 1,
    cacheWriteInputMultiplier: 1,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsPromptCaching: false,
    invocation: "converse",
    // 32k is the smallest window in the registry — below the product's
    // ~11k stable prefix plus a large file context; the pack shows what
    // overflows. Output ceiling 8k (below the #320 artifact floor).
    contextWindow: 32_000,
    defaultMaxTokens: 8_000,
    recommendedFor: [
      "short classification / routing calls",
      "cost-sensitive summaries of small inputs",
    ],
  },
  "qwen3-next-80b": {
    id: "qwen3-next-80b",
    bedrockModelId: "qwen.qwen3-next-80b-a3b",
    provider: "alibaba",
    family: "qwen3",
    displayName: "Qwen3 Next 80B",
    brandedName: "Qwen3 Next 80B",
    providerDisplayName: "Alibaba Cloud",
    blurb: "Qwen3 MoE (80B total / 3B active). Cheap, fast, 256k context.",
    // PRICING UNVERIFIED — Rob to confirm (third-party: $0.15 / $1.20 list).
    costPer1MInput: 0.15,
    costPer1MOutput: 1.2,
    cacheReadInputMultiplier: 1,
    cacheWriteInputMultiplier: 1,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsPromptCaching: false,
    invocation: "converse",
    contextWindow: 256_000,
    // Documented ceiling is 8k output tokens (below the #320 artifact floor).
    defaultMaxTokens: 8_000,
    recommendedFor: [
      "cost-sensitive chat and summarization",
      "routing / classification",
    ],
  },
  "kimi-k2-5": {
    id: "kimi-k2-5",
    bedrockModelId: "moonshotai.kimi-k2.5",
    provider: "moonshot",
    family: "kimi",
    displayName: "Kimi K2.5",
    brandedName: "Kimi K2.5",
    providerDisplayName: "Moonshot AI",
    blurb: "Moonshot's multimodal agent model. 256k context, image input.",
    // AWS Price List us-east-1 (2026-09-01): $0.60 / $3.00 per 1M, list.
    costPer1MInput: 0.6,
    costPer1MOutput: 3,
    cacheReadInputMultiplier: 1,
    cacheWriteInputMultiplier: 1,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: false,
    invocation: "converse",
    contextWindow: 256_000,
    // Documented ceiling 16k — exactly the #320 artifact floor.
    defaultMaxTokens: 16_000,
    recommendedFor: [
      "general chat and tool use",
      "image and document understanding",
    ],
  },
  "glm-4-7": {
    id: "glm-4-7",
    bedrockModelId: "zai.glm-4.7",
    provider: "zai",
    family: "glm",
    displayName: "GLM-4.7",
    brandedName: "GLM-4.7",
    providerDisplayName: "Z.ai",
    blurb: "Z.ai's previous-generation GLM. 203k context, 4k output cap.",
    // AWS Price List us-east-1 (2026-09-01): $0.60 / $2.20 per 1M, list.
    costPer1MInput: 0.6,
    costPer1MOutput: 2.2,
    cacheReadInputMultiplier: 1,
    cacheWriteInputMultiplier: 1,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsPromptCaching: false,
    invocation: "converse",
    contextWindow: 203_000,
    // Documented ceiling is 4k output tokens — the lowest in the registry and
    // far below the #320 artifact floor.
    defaultMaxTokens: 4_000,
    recommendedFor: ["short answers over long inputs", "routing / classification"],
  },
  "glm-5": {
    id: "glm-5",
    bedrockModelId: "zai.glm-5",
    provider: "zai",
    family: "glm",
    displayName: "GLM-5",
    brandedName: "GLM-5",
    providerDisplayName: "Z.ai",
    blurb: "Z.ai's frontier GLM for agentic work. 200k context, 128k output.",
    // AWS Price List us-east-1 (2026-09-01): $1.00 / $3.20 per 1M, list.
    costPer1MInput: 1,
    costPer1MOutput: 3.2,
    cacheReadInputMultiplier: 1,
    cacheWriteInputMultiplier: 1,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsPromptCaching: false,
    invocation: "converse",
    contextWindow: 200_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "general chat and multi-step tool use",
      "long-form writing and artifacts",
    ],
  },
  "nemotron-super-3-120b": {
    id: "nemotron-super-3-120b",
    bedrockModelId: "nvidia.nemotron-super-3-120b",
    provider: "nvidia",
    family: "nemotron",
    displayName: "Nemotron 3 Super 120B",
    brandedName: "Nemotron 3 Super 120B",
    providerDisplayName: "NVIDIA",
    blurb: "NVIDIA's open hybrid MoE (120B / 12B active). 256k context.",
    // PRICING UNVERIFIED — Rob to confirm (third-party: $0.15 / $0.65 list).
    costPer1MInput: 0.15,
    costPer1MOutput: 0.65,
    cacheReadInputMultiplier: 1,
    cacheWriteInputMultiplier: 1,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsPromptCaching: false,
    invocation: "converse",
    contextWindow: 256_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "cost-sensitive chat and summarization",
      "routing / classification",
    ],
  },
  "deepseek-v3-2": {
    id: "deepseek-v3-2",
    bedrockModelId: "deepseek.v3.2",
    provider: "deepseek",
    family: "deepseek",
    displayName: "DeepSeek V3.2",
    brandedName: "DeepSeek V3.2",
    providerDisplayName: "DeepSeek",
    blurb: "DeepSeek's MoE generalist. 164k context, 8k output cap.",
    // AWS Price List us-east-1 (2026-09-01): $0.62 / $1.85 per 1M, list.
    costPer1MInput: 0.62,
    costPer1MOutput: 1.85,
    cacheReadInputMultiplier: 1,
    cacheWriteInputMultiplier: 1,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsPromptCaching: false,
    invocation: "converse",
    contextWindow: 164_000,
    // Documented ceiling is 8k output tokens (below the #320 artifact floor).
    defaultMaxTokens: 8_000,
    recommendedFor: [
      "cost-sensitive chat and summarization",
      "analysis over long inputs",
    ],
  },
  /**
   * The three Claude 5.x entries were NOT invocable on 2026-09-06: every
   * Converse call returned AccessDeniedException "<model> is not available
   * for this account" (AWS account-gated Marketplace access; Rob is
   * escalating). They are registered so the qualification run is one
   * command once access lands; nothing below enables them.
   */
  "sonnet-5": {
    id: "sonnet-5",
    bedrockModelId: "us.anthropic.claude-sonnet-5",
    provider: "anthropic",
    family: "claude",
    displayName: "Sonnet 5",
    brandedName: "Claude Sonnet 5",
    providerDisplayName: "Anthropic",
    olderModelExample: "Claude 3.5",
    blurb: "Near-Opus capability at Sonnet cost. 1M context.",
    // PRICING UNVERIFIED on Bedrock — Anthropic list $2 / $10 + 10% us.*
    // (matches the accepted Marketplace agreement, 2.20 / 11).
    costPer1MInput: 2.2,
    costPer1MOutput: 11,
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: true,
    invocation: "converse",
    contextWindow: 1_000_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "general chat",
      "writing and analysis",
      "everyday tool use",
    ],
  },
  "opus-5": {
    id: "opus-5",
    bedrockModelId: "us.anthropic.claude-opus-5",
    provider: "anthropic",
    family: "claude",
    displayName: "Opus 5",
    brandedName: "Claude Opus 5",
    providerDisplayName: "Anthropic",
    olderModelExample: "Claude 3.5",
    blurb: "Anthropic's long-running-agent Opus. 1M context.",
    // PRICING UNVERIFIED on Bedrock — Anthropic list $5 / $25 + 10% us.*.
    costPer1MInput: 5.5,
    costPer1MOutput: 27.5,
    cacheReadInputMultiplier: 0.1,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: true,
    invocation: "converse",
    contextWindow: 1_000_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "multi-step planning",
      "hard reasoning",
      "authoring or refining recipe prompts",
    ],
  },
  "fable-5-1": {
    id: "fable-5-1",
    bedrockModelId: "us.anthropic.claude-fable-5-1",
    provider: "anthropic",
    family: "claude",
    displayName: "Fable 5.1",
    brandedName: "Claude Fable 5.1",
    providerDisplayName: "Anthropic",
    olderModelExample: "Claude 3.5",
    blurb: "Anthropic's frontier model. Thinking always on; 1M context.",
    // PRICING UNVERIFIED on Bedrock — Anthropic list $10 / $50 + 10% us.*;
    // cache reads at Anthropic's $0.25/MTok rate (0.025×), unverified here.
    // The model card also requires the `aws_review` data-retention opt-in
    // and rejects `temperature` (the loop never sends one by default).
    costPer1MInput: 11,
    costPer1MOutput: 55,
    cacheReadInputMultiplier: 0.025,
    cacheWriteInputMultiplier: 1.25,
    supportsToolUse: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPromptCaching: true,
    invocation: "converse",
    contextWindow: 1_000_000,
    defaultMaxTokens: 32_000,
    recommendedFor: [
      "the hardest reasoning and long-horizon agent work",
      "dense document and chart understanding",
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
