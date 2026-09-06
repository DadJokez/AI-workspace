import { appVersionDataBindings, type Database } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { parseDataBindings, type DataBinding } from "@/lib/app-data-bindings";

/**
 * Per-version binding declarations (#802). At publish time every binding an
 * artifact carries is pinned as an `app_version_data_bindings` row inside
 * the publish transaction; the rows are insert-only, so a version's data
 * surface cannot change after it is published (re-publishing or rolling
 * back to the same version keeps the original rows). The data endpoint
 * resolves a binding from these rows for the LIVE version, which is the
 * server-side declaration enforcement: a binding executes only if it belongs
 * to the version being served.
 *
 * Versions published before migration 0049 have no rows; for those the
 * artifact metadata (immutable per artifact version) remains the pin.
 */
type Writer = Pick<Database, "insert">;

export async function pinAppVersionDataBindings(
  tx: Writer,
  {
    appVersionId,
    bindings,
  }: { appVersionId: string; bindings: readonly DataBinding[] },
): Promise<void> {
  if (bindings.length === 0) return;
  await tx
    .insert(appVersionDataBindings)
    .values(
      bindings.map((binding) => ({
        appVersionId,
        bindingId: binding.id,
        provider: binding.provider,
        toolName: binding.toolName,
        pinnedArgs: binding.pinnedArgs,
        label: binding.label ?? null,
      })),
    )
    // Immutable per version: an existing declaration always wins.
    .onConflictDoNothing({
      target: [
        appVersionDataBindings.appVersionId,
        appVersionDataBindings.bindingId,
      ],
    });
}

export async function loadAppVersionDataBindings(
  db: Pick<Database, "select">,
  {
    appVersionId,
    artifactMetadata,
  }: { appVersionId: string | null; artifactMetadata: unknown },
): Promise<DataBinding[]> {
  if (appVersionId) {
    const rows = await db
      .select({
        id: appVersionDataBindings.bindingId,
        provider: appVersionDataBindings.provider,
        toolName: appVersionDataBindings.toolName,
        pinnedArgs: appVersionDataBindings.pinnedArgs,
        label: appVersionDataBindings.label,
      })
      .from(appVersionDataBindings)
      .where(eq(appVersionDataBindings.appVersionId, appVersionId));
    if (rows.length > 0) {
      // Same fail-closed shape validation as metadata bindings.
      return parseDataBindings({ dataBindings: rows });
    }
  }
  return parseDataBindings(artifactMetadata);
}
