import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  isValidModelId,
  type ModelId,
  type ModelPurpose,
} from "@ai-workspace/agent";
import { modelEnablement, type Database } from "@ai-workspace/db";
import { eq } from "drizzle-orm";

/**
 * Enablement half of the model registry (#300). Metadata lives in
 * `packages/agent/src/models.ts`; this module answers "may model X serve
 * purpose Y?" from the `model_enablement` table.
 *
 * Absence of a row = disabled: a newly registered model is disabled
 * everywhere until qualified (#301) and explicitly enabled (#302).
 *
 * Fail-open on infrastructure errors: if the table is unreachable (fresh dev
 * db, mocked test db, transient outage) every registry model counts as
 * enabled and a warning is logged — a broken enablement lookup must degrade
 * to pre-registry behavior, never brick chat. Fail-open covers DB *errors*
 * only; a reachable table with rows is authoritative.
 */

const CACHE_TTL_MS = 30_000;

let cache: { byPurpose: Map<string, Set<string>>; loadedAt: number } | null =
  null;

/** Admin mutations (#302) call this so changes apply without a redeploy. */
export function invalidateModelEnablementCache(): void {
  cache = null;
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
    return byPurpose;
  } catch (err) {
    process.stderr.write(
      `[model-enablement-load-error] ${JSON.stringify({
        message: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
    return null;
  }
}

/**
 * Registry model ids enabled for a purpose, in registry order. Fail-open:
 * all registry models when the table is unreachable.
 */
export async function enabledModelsForPurpose(
  db: Database,
  purpose: ModelPurpose,
): Promise<ModelId[]> {
  const byPurpose = await loadEnablement(db);
  if (byPurpose === null) return [...MODEL_IDS];
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
 * Resolve the model to use for a purpose. `preferred` (an env override or a
 * pinned id) wins when it is registered and enabled; otherwise the app
 * default when enabled; otherwise the first enabled model in registry order.
 * If nothing is enabled for the purpose (misconfiguration — the seed enables
 * every current purpose), falls back to the app default and logs, because a
 * config mistake must not take chat down.
 */
export async function resolveModelForPurpose(
  db: Database,
  purpose: ModelPurpose,
  options: { preferred?: string | null } = {},
): Promise<ModelId> {
  const enabled = await enabledModelsForPurpose(db, purpose);
  const preferred = options.preferred?.trim().toLowerCase();

  if (preferred && isValidModelId(preferred) && enabled.includes(preferred)) {
    return preferred;
  }
  if (enabled.includes(DEFAULT_MODEL_ID)) return DEFAULT_MODEL_ID;
  if (enabled.length > 0) return enabled[0]!;

  process.stderr.write(
    `[model-enablement-empty] ${JSON.stringify({
      purpose,
      fallback: DEFAULT_MODEL_ID,
    })}\n`,
  );
  return DEFAULT_MODEL_ID;
}
