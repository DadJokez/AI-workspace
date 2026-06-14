import {
  DEFAULT_MODEL_ID,
  MODELS,
  isValidModelId,
  type ModelId,
} from "@ai-workspace/agent";
import type { RuntimeName } from "@ai-workspace/agent-runtime";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";

export interface RuntimeModelSelection {
  requestedModelId: string;
  modelId: string;
  providerModelId?: string;
  reason:
    | "runtime_v2_direct_model_config"
    | "runtime_v2_autopilot"
    | "requested_model_alias"
    | "requested_model_supported"
    | "default_model_fallback";
  ignoredDirectModelId?: string;
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
  route: _route,
  runtimeName,
  directModelId = process.env.RUNTIME_V2_DIRECT_MODEL_ID,
  message,
}: {
  requestedModelId: string;
  route: Pick<ChatRuntimeRoute, "runtimeTarget">;
  runtimeName: RuntimeName;
  directModelId?: string;
  /** The user's message, used by autopilot to pick a model per ask. */
  message?: string;
}): RuntimeModelSelection {
  void _route;
  void runtimeName;

  const configuredDirectModel = directModelId?.trim().toLowerCase();

  // Autopilot: pick the model per ask instead of pinning one.
  if (configuredDirectModel === "auto" && typeof message === "string") {
    return directSelection({
      requestedModelId,
      modelId: selectAutopilotModel(message),
      reason: "runtime_v2_autopilot",
    });
  }

  if (configuredDirectModel && isValidModelId(configuredDirectModel)) {
    return directSelection({
      requestedModelId,
      modelId: configuredDirectModel,
      reason: "runtime_v2_direct_model_config",
    });
  }

  const normalizedRequested = requestedModelId.trim().toLowerCase();
  const alias = DIRECT_MODEL_ALIASES[normalizedRequested];
  if (alias) {
    return directSelection({
      requestedModelId,
      modelId: alias,
      reason: "requested_model_alias",
      ignoredDirectModelId: configuredDirectModel,
    });
  }

  if (isValidModelId(normalizedRequested)) {
    return directSelection({
      requestedModelId,
      modelId: normalizedRequested,
      reason: "requested_model_supported",
      ignoredDirectModelId: configuredDirectModel,
    });
  }

  return directSelection({
    requestedModelId,
    modelId: DEFAULT_MODEL_ID,
    reason: "default_model_fallback",
    ignoredDirectModelId: configuredDirectModel,
  });
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
