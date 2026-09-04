/**
 * Live-data app bindings (#407, generalized in #802). A servable app
 * artifact can carry, in its (immutable, per-version)
 * `workspaceArtifacts.metadata.dataBindings`, a list of PINNED read-only
 * tool calls: any `tools_catalog` read tool plus the arguments fixed at
 * publish time. A deployed app's Refresh invokes a binding *by id* through
 * `GET /api/apps/[id]/data/[bindingId]`, which runs the pinned call under
 * the VIEWER's own connection — never the author's.
 *
 * This module is a client-safe leaf: shape parsing, the strings that need
 * secret-scanning at mint, and the client-facing scrub that hides pinned
 * arguments from viewers (the browser only ever needs the binding id). The
 * provider gate, catalog read-only check, and execution live server-side.
 *
 * Storage shapes accepted (both normalize to `DataBinding`):
 *   generic (#802): { id, provider, toolName, pinnedArgs, label? }
 *   legacy  (#407): { id, provider: "salesforce", kind: "soql", query, label? }
 * The legacy shape keeps working unchanged — it is read as
 * `salesforce/run_soql` with `pinnedArgs: { soql: query }`.
 */

export interface DataBinding {
  id: string;
  /** `tools_catalog.provider` slug, e.g. "salesforce", "github". */
  provider: string;
  /** `tools_catalog.tool_name` of a READ tool, e.g. "run_soql", "list_issues". */
  toolName: string;
  /** Arguments pinned at publish. Server-only — never serialized to viewers. */
  pinnedArgs: Record<string, unknown>;
  /** Optional human label for the bound dataset (safe to expose). */
  label?: string;
}

/** The client-safe view of a binding: everything except the pinned arguments. */
export type PublicDataBinding = Omit<DataBinding, "pinnedArgs">;

/** Legacy #407 SOQL bindings normalize onto this catalog tool. */
export const LEGACY_SOQL_PROVIDER = "salesforce";
export const LEGACY_SOQL_TOOL_NAME = "run_soql";

export const MAX_DATA_BINDINGS = 12;
const MAX_ID_CHARS = 64;
const MAX_LABEL_CHARS = 120;
/** Bound on serialized pinned arguments; a SOQL query fits comfortably. */
export const MAX_PINNED_ARGS_CHARS = 16_000;
const CATALOG_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isCatalogSlug(value: unknown): value is string {
  return typeof value === "string" && CATALOG_SLUG_RE.test(value);
}

function normalizeBinding(row: Record<string, unknown>): DataBinding | null {
  const { id, provider, label } = row;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_CHARS) {
    return null;
  }
  if (!isCatalogSlug(provider)) return null;

  let toolName: string;
  let pinnedArgs: Record<string, unknown>;
  if (row.kind === "soql") {
    // Legacy #407 shape: a pinned SOQL SELECT on the viewer's Salesforce.
    if (provider !== LEGACY_SOQL_PROVIDER) return null;
    const query = row.query;
    if (typeof query !== "string" || query.trim().length === 0) return null;
    toolName = LEGACY_SOQL_TOOL_NAME;
    pinnedArgs = { soql: query };
  } else {
    if (!isCatalogSlug(row.toolName)) return null;
    const args = asRecord(row.pinnedArgs);
    if (!args) return null;
    toolName = row.toolName;
    pinnedArgs = args;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(pinnedArgs);
  } catch {
    return null;
  }
  if (typeof serialized !== "string" || serialized.length > MAX_PINNED_ARGS_CHARS) {
    return null;
  }
  return {
    id,
    provider,
    toolName,
    pinnedArgs,
    ...(typeof label === "string" && label.length > 0
      ? { label: label.slice(0, MAX_LABEL_CHARS) }
      : {}),
  };
}

/**
 * Parse and validate the `dataBindings` in artifact metadata. Fails closed:
 * any malformed entry is dropped rather than trusted, duplicate ids collapse
 * to the first, and an over-long list is truncated. Returns [] when absent.
 * This validates SHAPE only — the provider gate, the catalog read-only
 * check, and per-tool argument re-validation are applied separately
 * (server-only) at publish and fetch.
 */
export function parseDataBindings(metadata: unknown): DataBinding[] {
  const record = asRecord(metadata);
  const raw = record?.dataBindings;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const bindings: DataBinding[] = [];
  for (const entry of raw) {
    const row = asRecord(entry);
    if (!row) continue;
    const binding = normalizeBinding(row);
    if (!binding || seen.has(binding.id)) continue;
    seen.add(binding.id);
    bindings.push(binding);
    if (bindings.length >= MAX_DATA_BINDINGS) break;
  }
  return bindings;
}

/** Find one binding by id (after shape validation). */
export function findDataBinding(
  metadata: unknown,
  bindingId: string,
): DataBinding | null {
  return (
    parseDataBindings(metadata).find((binding) => binding.id === bindingId) ??
    null
  );
}

/** Stable `provider:toolName` key matching `tools_catalog` rows. */
export function bindingCatalogKey(
  binding: Pick<DataBinding, "provider" | "toolName">,
): string {
  return `${binding.provider}:${binding.toolName}`;
}

/**
 * The strings that must pass the mint/publish secret scan — pinned
 * arguments in metadata otherwise bypass the scan that only covers artifact
 * HTML content. Serialized so nested string values are covered too.
 */
export function bindingScanStrings(metadata: unknown): string[] {
  return parseDataBindings(metadata).map((binding) =>
    JSON.stringify(binding.pinnedArgs),
  );
}

/**
 * The allowlisted viewer-facing view of one binding. Never spread the
 * binding — a future server-side field can't silently leak the way
 * `pinnedArgs` would.
 */
export function publicDataBinding(binding: DataBinding): PublicDataBinding {
  return {
    id: binding.id,
    provider: binding.provider,
    toolName: binding.toolName,
    ...(binding.label !== undefined ? { label: binding.label } : {}),
  };
}

/**
 * Client-facing metadata: strips every binding's pinned arguments so a
 * viewer (who invokes bindings by id) never receives the author's query or
 * arguments. Returns the metadata unchanged when it carries no bindings.
 */
export function scrubBindingsForClient(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata || !Array.isArray(metadata.dataBindings)) return metadata;
  return {
    ...metadata,
    dataBindings: parseDataBindings(metadata).map(publicDataBinding),
  };
}
