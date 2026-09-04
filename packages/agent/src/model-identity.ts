import { MODELS, type ModelId, type ModelMetadata } from "./models";

/**
 * The runtime-injected identity sentence — the ONE production template
 * (#856, #797 P1). `runAgentLoop` prepends it to the stable (cached) system
 * prompt, the choke point every lane shares (bedrock inline, agentcore host,
 * evals harness), so no durable prompt text ever states a vendor (#304).
 *
 * Registry-derived: the vendor and branded name come from `ModelMetadata`,
 * never from this file, so a non-Claude brain gets a truthful line with zero
 * prompt changes. Keyed off the `MODELS` object rather than `MODEL_IDS` so a
 * metadata-only entry (the #797 exit test's fake Converse brain) is still
 * named truthfully; an id the registry does not know at all (a candidate
 * model mid-qualification, an eval fixture) gets a neutral sentence with no
 * hardcoded vendor.
 */
export function modelIdentityLine(modelId: string): string {
  const model = registryEntry(modelId);
  if (!model) {
    return `You are powered by the model registered as "${modelId}". If asked which model or version you are, answer "${modelId}" — never claim to be a different model or vendor.`;
  }
  // `olderModelExample` is optional: a family with no known training-prior
  // misclaim gets the neutral wording.
  const olderModel = model.olderModelExample
    ? ` or an older model such as "${model.olderModelExample}"`
    : " or an older model version";
  return `You are powered by ${model.brandedName}, made by ${model.providerDisplayName}. If asked which model or version you are, answer "${model.brandedName}" — never claim to be a different vendor's model${olderModel}.`;
}

function registryEntry(modelId: string): ModelMetadata | undefined {
  // Own-property check: "constructor" / "toString" resolve through the
  // object's prototype and would otherwise render "powered by undefined".
  return Object.hasOwn(MODELS, modelId)
    ? MODELS[modelId as ModelId]
    : undefined;
}
