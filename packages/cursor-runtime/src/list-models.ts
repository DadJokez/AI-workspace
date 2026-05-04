import { Cursor, type SDKModel } from "@cursor/sdk";

/**
 * Thin wrapper around `Cursor.models.list({ apiKey })`. Lives here so the web
 * app doesn't need a direct dependency on `@cursor/sdk` — `cursor-runtime`
 * stays the single boundary that owns the SDK import.
 *
 * Returns the models the authenticated key has access to. The caller layers
 * its own caching / fallback policy.
 */
export async function listCursorModels(
  apiKey?: string,
): Promise<SDKModel[]> {
  return Cursor.models.list({ apiKey });
}

export type { SDKModel };
