import { MODELS, isValidModelId } from "@ai-workspace/agent/models";

export function modelDisplayName(modelId: string): string {
  return isValidModelId(modelId)
    ? MODELS[modelId].displayName
    : "Comparative model";
}
