/**
 * Live-data app bindings (#407). A servable app artifact can carry, in its
 * (immutable, per-version) `workspaceArtifacts.metadata.dataBindings`, a list
 * of PINNED read-only queries. A deployed app's Refresh invokes a binding
 * *by id* through `GET /api/apps/[id]/data/[bindingId]`, which runs the
 * pinned query under the VIEWER's own connection — never the author's.
 *
 * This module is a client-safe leaf: shape parsing, the query strings that
 * need secret-scanning at mint, and the client-facing scrub that hides raw
 * queries from viewers (the browser only ever needs the binding id). The
 * read-only SOQL enforcement lives in the server-only salesforce module and
 * is applied at both mint and fetch time.
 */

/** The only provider/kind with a read query runner today (#407 v1). */
export const SUPPORTED_BINDING_PROVIDERS = ["salesforce"] as const;
export type DataBindingProvider = (typeof SUPPORTED_BINDING_PROVIDERS)[number];

export interface DataBinding {
  id: string;
  provider: DataBindingProvider;
  kind: "soql";
  /** The pinned query. Server-only — never serialized to app viewers. */
  query: string;
  /** Optional human label for the bound dataset (safe to expose). */
  label?: string;
}

/** The client-safe view of a binding: everything except the raw query. */
export type PublicDataBinding = Omit<DataBinding, "query">;

export const MAX_DATA_BINDINGS = 12;
const MAX_BINDINGS = MAX_DATA_BINDINGS;
const MAX_LABEL_CHARS = 120;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSupportedProvider(value: unknown): value is DataBindingProvider {
  return (
    typeof value === "string" &&
    (SUPPORTED_BINDING_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Parse and validate the `dataBindings` in artifact metadata. Fails closed:
 * any malformed entry is dropped rather than trusted, duplicate ids collapse
 * to the first, and an over-long list is truncated. Returns [] when absent.
 * This validates SHAPE only — read-only SOQL enforcement is applied
 * separately (server-only) at mint and fetch.
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
    const { id, provider, kind, query, label } = row;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      !isSupportedProvider(provider) ||
      kind !== "soql" ||
      typeof query !== "string" ||
      query.trim().length === 0 ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    bindings.push({
      id,
      provider,
      kind,
      query,
      ...(typeof label === "string" && label.length > 0
        ? { label: label.slice(0, MAX_LABEL_CHARS) }
        : {}),
    });
    if (bindings.length >= MAX_BINDINGS) break;
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

/**
 * The query strings that must pass the mint/deploy secret scan — a SOQL
 * string in metadata otherwise bypasses the scan that only covers artifact
 * HTML content today.
 */
export function bindingQueryStrings(metadata: unknown): string[] {
  return parseDataBindings(metadata).map((binding) => binding.query);
}

/**
 * Client-facing metadata: strips every binding's raw `query` so a viewer
 * (who invokes bindings by id) never receives the author's query text.
 * Returns the metadata unchanged when it carries no bindings.
 */
export function scrubBindingsForClient(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!metadata || !Array.isArray(metadata.dataBindings)) return metadata;
  // Allowlist the fields a viewer may see — never spread the binding, so a
  // future field can't silently leak the way `query` would.
  const publicBindings: PublicDataBinding[] = parseDataBindings(metadata).map(
    (binding) => ({
      id: binding.id,
      provider: binding.provider,
      kind: binding.kind,
      ...(binding.label !== undefined ? { label: binding.label } : {}),
    }),
  );
  return { ...metadata, dataBindings: publicBindings };
}
