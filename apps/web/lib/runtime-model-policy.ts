import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  isValidModelId,
  type ModelId,
} from "@ai-workspace/agent";
import type { RuntimeName } from "@ai-workspace/agent-runtime";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";

export interface RuntimeModelSelection {
  requestedModelId: string;
  modelId: ModelId;
  providerModelId?: string;
  reason:
    | "runtime_v2_direct_model_config"
    | "runtime_v2_autopilot"
    | "model_decided_sonnet"
    | "requested_model_alias"
    | "requested_model_supported"
    | "default_model_fallback"
    | "availability_failover";
  ignoredDirectModelId?: string;
  failover?: {
    fromModelId: ModelId;
    attempt: number;
  };
}

export interface ChatModelPreference {
  modelId: string;
  source: "user_override" | "skill_pin" | "request_default";
}

/**
 * Explicit user intent outranks a skill pin; absent an override, the active
 * skill outranks the request/thread default.
 */
export function resolveChatModelPreference({
  requestedModelId,
  modelOverride,
  skillModelId,
}: {
  requestedModelId: string;
  modelOverride: boolean;
  skillModelId?: string | null;
}): ChatModelPreference {
  if (modelOverride) {
    return { modelId: requestedModelId, source: "user_override" };
  }
  if (skillModelId) {
    return { modelId: skillModelId, source: "skill_pin" };
  }
  return { modelId: requestedModelId, source: "request_default" };
}

/**
 * #110 server-side model autopilot. When `RUNTIME_V2_DIRECT_MODEL_ID=auto`,
 * the backend picks the model per ask instead of pinning Haiku for
 * everything: Haiku for short/simple turns (fast, cheap), Sonnet for
 * writing-grade and reasoning-heavy work (drafts, summaries, analysis, code).
 * Deterministic heuristic — no extra model call, so it adds zero latency to
 * the fast lane. Biases to Sonnet when unsure, because the complaint was
 * Haiku being too weak for user-facing writing.
 */
const WRITING_OR_REASONING_SIGNAL =
  /\b(write|draft|compose|rewrite|reword|polish|proofread|edit|summar(?:y|ise|ize)|summari[sz]e|essay|memo|report|blog|article|post|letter|paragraph|explain|analy[sz]e|analysis|compare|evaluate|assess|plan|outline|strateg|brainstorm|translate|critique|review|recommend|pros and cons|step by step)\b/i;

export function selectAutopilotModel(message: string): ModelId {
  const trimmed = message.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const hasCode = /```|\bfunction\b|\bclass\b|=>|;\s*$/m.test(message);

  // Substantive / writing / reasoning / code / long → Sonnet (quality).
  if (hasCode || words > 24 || WRITING_OR_REASONING_SIGNAL.test(message)) {
    return "sonnet-4-6";
  }
  // Very short, simple turns (greetings, quick factual asks) → Haiku.
  if (words <= 8) return "haiku-4-5";
  // Default: bias to quality for user-facing chat.
  return "sonnet-4-6";
}

export function resolveRuntimeModelSelection({
  requestedModelId,
  route,
  runtimeName,
  directModelId = process.env.RUNTIME_V2_DIRECT_MODEL_ID,
  message,
  forceRequestedModel = false,
  enabledModelIds,
}: {
  requestedModelId: string;
  route: Pick<ChatRuntimeRoute, "runtimeTarget" | "routingMode">;
  runtimeName: RuntimeName;
  directModelId?: string;
  /** The user's message, used by autopilot to pick a model per ask. */
  message?: string;
  /** True when the user explicitly pinned a supported model for this turn. */
  forceRequestedModel?: boolean;
  /**
   * Registry enablement for this turn's purpose (#300). Candidates outside
   * the set are skipped as if they weren't registered — a disabled model can
   * never be selected. Omitted = all registry models allowed.
   */
  enabledModelIds?: ReadonlySet<string>;
}): RuntimeModelSelection {
  void runtimeName;

  if (
    enabledModelIds &&
    !MODEL_IDS.some((modelId) => enabledModelIds.has(modelId))
  ) {
    throw new Error("No models are enabled for this runtime lane.");
  }

  const allowed = (id: ModelId) =>
    !enabledModelIds || enabledModelIds.has(id);
  // End-of-chain fallback when preferred candidates are disabled: the app
  // default when enabled, else the first enabled model in registry order.
  const fallbackModelId = (): ModelId =>
    allowed(DEFAULT_MODEL_ID)
      ? DEFAULT_MODEL_ID
      : (MODEL_IDS.find((id) => allowed(id)) ?? DEFAULT_MODEL_ID);

  const configuredDirectModel = directModelId?.trim().toLowerCase();
  const normalizedRequested = requestedModelId.trim().toLowerCase();
  const requestedAlias = DIRECT_MODEL_ALIASES[normalizedRequested];

  if (forceRequestedModel && requestedAlias && allowed(requestedAlias)) {
    return directSelection({
      requestedModelId,
      modelId: requestedAlias,
      reason: "requested_model_alias",
      ignoredDirectModelId: configuredDirectModel,
    });
  }

  if (
    forceRequestedModel &&
    isValidModelId(normalizedRequested) &&
    allowed(normalizedRequested)
  ) {
    return directSelection({
      requestedModelId,
      modelId: normalizedRequested,
      reason: "requested_model_supported",
      ignoredDirectModelId: configuredDirectModel,
    });
  }

  if (route.routingMode === "model-decided") {
    return directSelection({
      requestedModelId,
      modelId: allowed("sonnet-4-6") ? "sonnet-4-6" : fallbackModelId(),
      reason: "model_decided_sonnet",
      ignoredDirectModelId: configuredDirectModel,
    });
  }

  // Autopilot: pick the model per ask instead of pinning one.
  if (configuredDirectModel === "auto" && typeof message === "string") {
    const pick = selectAutopilotModel(message);
    return directSelection({
      requestedModelId,
      modelId: allowed(pick) ? pick : fallbackModelId(),
      reason: "runtime_v2_autopilot",
    });
  }

  if (
    configuredDirectModel &&
    isValidModelId(configuredDirectModel) &&
    allowed(configuredDirectModel)
  ) {
    return directSelection({
      requestedModelId,
      modelId: configuredDirectModel,
      reason: "runtime_v2_direct_model_config",
    });
  }

  if (requestedAlias && allowed(requestedAlias)) {
    return directSelection({
      requestedModelId,
      modelId: requestedAlias,
      reason: "requested_model_alias",
      ignoredDirectModelId: configuredDirectModel,
    });
  }

  if (isValidModelId(normalizedRequested) && allowed(normalizedRequested)) {
    return directSelection({
      requestedModelId,
      modelId: normalizedRequested,
      reason: "requested_model_supported",
      ignoredDirectModelId: configuredDirectModel,
    });
  }

  return directSelection({
    requestedModelId,
    modelId: fallbackModelId(),
    reason: "default_model_fallback",
    ignoredDirectModelId: configuredDirectModel,
  });
}

export function applyRuntimeModelFailover(
  selection: RuntimeModelSelection,
  nextModelId: ModelId,
  fromModelId: ModelId,
  attempt: number,
): RuntimeModelSelection {
  return {
    ...selection,
    modelId: nextModelId,
    providerModelId: MODELS[nextModelId].bedrockModelId,
    reason: "availability_failover",
    failover: { fromModelId, attempt },
  };
}

function directSelection({
  requestedModelId,
  modelId,
  reason,
  ignoredDirectModelId,
}: {
  requestedModelId: string;
  modelId: ModelId;
  reason: RuntimeModelSelection["reason"];
  ignoredDirectModelId?: string;
}): RuntimeModelSelection {
  return {
    requestedModelId,
    modelId,
    providerModelId: MODELS[modelId].bedrockModelId,
    reason,
    ...(ignoredDirectModelId ? { ignoredDirectModelId } : {}),
  };
}

const DIRECT_MODEL_ALIASES: Record<string, ModelId> = {
  "claude-haiku-4-5": "haiku-4-5",
  "claude-haiku-4-5-20251001": "haiku-4-5",
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": "haiku-4-5",
  "claude-sonnet-4-6": "sonnet-4-6",
  "us.anthropic.claude-sonnet-4-6": "sonnet-4-6",
  "claude-opus-4-7": "opus-4-7",
  "us.anthropic.claude-opus-4-7": "opus-4-7",
};
