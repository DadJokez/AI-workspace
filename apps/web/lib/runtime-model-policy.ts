import {
  DEFAULT_MODEL_ID,
  MODELS,
  isValidModelId,
  type ModelId,
} from "@ai-workspace/agent";
import type { RuntimeName } from "@ai-workspace/cursor-runtime";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";

export interface RuntimeModelSelection {
  requestedModelId: string;
  modelId: string;
  providerModelId?: string;
  reason:
    | "runtime_passthrough"
    | "runtime_v2_direct_model_config"
    | "requested_model_alias"
    | "requested_model_supported"
    | "default_model_fallback";
  ignoredDirectModelId?: string;
}

export function resolveRuntimeModelSelection({
  requestedModelId,
  route,
  runtimeName,
  directModelId = process.env.RUNTIME_V2_DIRECT_MODEL_ID,
}: {
  requestedModelId: string;
  route: Pick<ChatRuntimeRoute, "runtimeTarget">;
  runtimeName: RuntimeName;
  directModelId?: string;
}): RuntimeModelSelection {
  if (route.runtimeTarget !== "direct-chat" || runtimeName !== "bedrock") {
    return {
      requestedModelId,
      modelId: requestedModelId,
      providerModelId: requestedModelId,
      reason: "runtime_passthrough",
    };
  }

  const configuredDirectModel = directModelId?.trim().toLowerCase();
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
