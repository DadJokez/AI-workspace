import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  PLATFORM_MODEL_OVERRIDE_ID,
  isValidModelId,
  type ModelId,
  type ModelPurpose,
} from "@ai-workspace/agent";
import { modelEnablement, type Database } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { resolveModelFailoverChain } from "@/lib/runtime-model-policy";

/**
 * Enablement half of the model registry (#300). Metadata lives in
 * `packages/agent/src/models.ts`; this module answers "may model X serve
 * purpose Y?" from the `model_enablement` table.
 *
 * Absence of a row = disabled: a newly registered model is disabled
 * everywhere until qualified (#301) and explicitly enabled (#302). The
 * temporary platform model override is the one exception: while active it
 * supersedes persisted enablement without rewriting those records.
 *
 * On infrastructure errors only the platform default may serve. A reachable
 * table remains authoritative, including an empty result. Failed reads share
 * the normal cache TTL so an outage cannot flood the DB or warning log.
 */

const CACHE_TTL_MS = 30_000;
const COST_OPTIMIZED_PURPOSES = new Set<ModelPurpose>([
  "fast-local",
  "summaries",
  "routing",
  "memory-capture",
]);

let cache: { byPurpose: Map<string, Set<string>> | null; loadedAt: number } | null =
  null;
const warnedUnavailablePurposes = new Set<ModelPurpose>();

export interface ModelEnablementFallback {
  reason: "model_enablement_unavailable";
  message: string;
  purpose: ModelPurpose;
  modelId: ModelId;
}

interface EnablementReadOptions {
  onUnavailable?: (receipt: ModelEnablementFallback) => void;
}

/** Admin mutations (#302) call this so changes apply without a redeploy. */
export function invalidateModelEnablementCache(): void {
  cache = null;
  warnedUnavailablePurposes.clear();
}

async function loadEnablement(
  db: Database,
): Promise<Map<string, Set<string>> | null> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.byPurpose;
  }
  try {
    const rows = await db
      .select({
        modelId: modelEnablement.modelId,
        purpose: modelEnablement.purpose,
      })
      .from(modelEnablement)
      .where(eq(modelEnablement.enabled, true));
    const byPurpose = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = byPurpose.get(row.purpose) ?? new Set<string>();
      set.add(row.modelId);
      byPurpose.set(row.purpose, set);
    }
    cache = { byPurpose, loadedAt: Date.now() };
    warnedUnavailablePurposes.clear();
    return byPurpose;
  } catch {
    cache = { byPurpose: null, loadedAt: Date.now() };
    return null;
  }
}

/**
 * Registry model ids enabled for a purpose, in registry order. The temporary
 * platform override wins for every purpose. Otherwise, only the default is
 * available when the table cannot be read.
 */
export async function enabledModelsForPurpose(
  db: Database,
  purpose: ModelPurpose,
  options: EnablementReadOptions = {},
): Promise<ModelId[]> {
  if (PLATFORM_MODEL_OVERRIDE_ID) return [PLATFORM_MODEL_OVERRIDE_ID];

  const byPurpose = await loadEnablement(db);
  if (byPurpose === null) {
    const receipt: ModelEnablementFallback = {
      reason: "model_enablement_unavailable",
      message: "Model enablement unavailable — using the default",
      purpose,
      modelId: DEFAULT_MODEL_ID,
    };
    if (!warnedUnavailablePurposes.has(purpose)) {
      warnedUnavailablePurposes.add(purpose);
      process.stderr.write(
        `[model-enablement-load-error] ${JSON.stringify(receipt)}\n`,
      );
    }
    options.onUnavailable?.(receipt);
    return [DEFAULT_MODEL_ID];
  }
  const enabled = byPurpose.get(purpose) ?? new Set<string>();
  return MODEL_IDS.filter((id) => enabled.has(id));
}

export async function isModelEnabled(
  db: Database,
  modelId: string,
  purpose: ModelPurpose,
): Promise<boolean> {
  if (!isValidModelId(modelId)) return false;
  const enabled = await enabledModelsForPurpose(db, purpose);
  return enabled.includes(modelId);
}

/**
 * Order an already-enabled set for one turn. The selected primary stays
 * first; fallback order then follows lane policy without ever introducing a
 * model outside the enablement gate.
 */
export function orderModelCandidatesForPurpose(
  purpose: ModelPurpose,
  enabledModelIds: readonly ModelId[],
  primaryModelId: ModelId,
): ModelId[] {
  const enabled = MODEL_IDS.filter((id) => enabledModelIds.includes(id));
  if (enabled.length === 0) {
    throw new Error(`No models are enabled for purpose "${purpose}".`);
  }
  const policyOrder = COST_OPTIMIZED_PURPOSES.has(purpose)
    ? [...enabled].sort(compareModelCost)
    : [
        ...(enabled.includes(DEFAULT_MODEL_ID) ? [DEFAULT_MODEL_ID] : []),
        ...enabled
          .filter((id) => id !== DEFAULT_MODEL_ID)
          .sort(compareModelCapability),
      ];
  const primary = enabled.includes(primaryModelId)
    ? primaryModelId
    : policyOrder[0]!;
  // #797 P3: every hop that crosses providers must land on a qualified model.
  // The chain is built from `enabled` alone, so the guard holds by
  // construction here; it is the contract a persisted qualification record
  // would replace `enabled` in, without touching either lane.
  return resolveModelFailoverChain(
    [primary, ...policyOrder.filter((id) => id !== primary)],
    new Set(enabled),
  );
}

/**
 * Resolve every enabled candidate in bounded attempt order. A caller
 * preference wins when allowed; otherwise cheap internal purposes select the
 * lowest-cost qualified model and user-facing purposes keep the app default.
 */
export async function resolveModelCandidatesForPurpose(
  db: Database,
  purpose: ModelPurpose,
  options: { preferred?: string | null } & EnablementReadOptions = {},
): Promise<ModelId[]> {
  const enabled = await enabledModelsForPurpose(db, purpose, options);
  const preferred = options.preferred?.trim().toLowerCase();
  const preferredModel =
    preferred && isValidModelId(preferred) && enabled.includes(preferred)
      ? preferred
      : null;
  const policyPrimary = COST_OPTIMIZED_PURPOSES.has(purpose)
    ? [...enabled].sort(compareModelCost)[0]
    : enabled.includes(DEFAULT_MODEL_ID)
      ? DEFAULT_MODEL_ID
      : enabled[0];
  const primary = preferredModel ?? policyPrimary;

  if (!primary) {
    throw new Error(`No models are enabled for purpose "${purpose}".`);
  }

  return orderModelCandidatesForPurpose(purpose, enabled, primary);
}

/**
 * Resolve the model to use for a purpose. `preferred` (an env override or a
 * pinned id) wins when it is registered and enabled; otherwise internal
 * purposes use the cheapest enabled model and user-facing purposes use the
 * app default when enabled.
 * A reachable registry with no enabled model fails closed: selecting a
 * disabled fallback would violate the enablement hard gate.
 */
export async function resolveModelForPurpose(
  db: Database,
  purpose: ModelPurpose,
  options: { preferred?: string | null } & EnablementReadOptions = {},
): Promise<ModelId> {
  return (await resolveModelCandidatesForPurpose(db, purpose, options))[0]!;
}

function compareModelCost(a: ModelId, b: ModelId): number {
  const aCost = MODELS[a].costPer1MInput + MODELS[a].costPer1MOutput;
  const bCost = MODELS[b].costPer1MInput + MODELS[b].costPer1MOutput;
  return aCost - bCost;
}

function compareModelCapability(a: ModelId, b: ModelId): number {
  return MODELS[b].costPer1MOutput - MODELS[a].costPer1MOutput;
}
