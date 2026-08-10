export const CONTEXT_RESOURCE_KINDS = [
  "artifact",
  "vault_item",
  "app_version",
  "google_mail_thread",
] as const;

export type ContextResourceKind = (typeof CONTEXT_RESOURCE_KINDS)[number];

export const CONTEXT_RESOURCE_STATES = [
  "included",
  "unavailable",
  "discoverable-not-mounted",
  "policy-blocked",
  "budget-omitted",
  "generated-during-run",
] as const;

export type ContextResourceState = (typeof CONTEXT_RESOURCE_STATES)[number];

export const CONTEXT_RESOURCE_REASONS = [
  "not_found",
  "wrong_thread",
  "missing_connection",
  "reconnect_required",
  "temporarily_unavailable",
  "stale_version",
  "oversize",
  "context_budget_exhausted",
  "extraction_failed",
  "policy_denied",
] as const;

export type ContextResourceReason =
  (typeof CONTEXT_RESOURCE_REASONS)[number];

export interface ContextResourceReference {
  version: 1;
  kind: ContextResourceKind;
  resourceId: string;
  /** Required for resources whose upstream id is scoped by a container. */
  containerId?: string;
}

export interface ContextResourceSearchResult {
  reference: ContextResourceReference;
  label: string;
  description: string;
  sourceLabel: string;
  provider?: string;
  versionLabel?: string;
}

export type ContextResourceSearchScope = "workspace" | "google_mail";

export interface ContextResourceScopeOption {
  scope: Exclude<ContextResourceSearchScope, "workspace">;
  label: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
}

export interface ContextResourceSearchResponse {
  results: ContextResourceSearchResult[];
  scopes: ContextResourceScopeOption[];
}

export function parseContextResourceSearchResponse(
  value: unknown,
): ContextResourceSearchResponse | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.scopes)
  ) {
    return null;
  }
  const results = value.results.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const reference = parseContextResourceReference(candidate.reference);
    if (
      !reference ||
      typeof candidate.label !== "string" ||
      typeof candidate.description !== "string" ||
      typeof candidate.sourceLabel !== "string"
    ) {
      return [];
    }
    return [{
      reference,
      label: candidate.label.slice(0, 240),
      description: candidate.description.slice(0, 400),
      sourceLabel: candidate.sourceLabel.slice(0, 120),
      ...(typeof candidate.provider === "string"
        ? { provider: candidate.provider.slice(0, 80) }
        : {}),
      ...(typeof candidate.versionLabel === "string"
        ? { versionLabel: candidate.versionLabel.slice(0, 80) }
        : {}),
    } satisfies ContextResourceSearchResult];
  });
  const scopes = value.scopes.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      candidate.scope !== "google_mail" ||
      typeof candidate.label !== "string" ||
      typeof candidate.description !== "string" ||
      typeof candidate.available !== "boolean"
    ) {
      return [];
    }
    return [{
      scope: candidate.scope,
      label: candidate.label.slice(0, 120),
      description: candidate.description.slice(0, 240),
      available: candidate.available,
      ...(typeof candidate.unavailableReason === "string"
        ? { unavailableReason: candidate.unavailableReason.slice(0, 240) }
        : {}),
    } satisfies ContextResourceScopeOption];
  });
  return { results, scopes };
}

/**
 * Browser persistence keeps stable references and the minimum display data.
 * Search snippets can contain connector content and must remain ephemeral.
 */
export function contextResourceSelectionsForPersistence(
  resources: readonly ContextResourceSearchResult[],
): ContextResourceSearchResult[] {
  return resources.slice(0, MAX_CONTEXT_RESOURCE_REFERENCES).map((resource) => ({
    reference: resource.reference,
    label: resource.label,
    description: "",
    sourceLabel: resource.sourceLabel,
    ...(resource.provider ? { provider: resource.provider } : {}),
    ...(resource.versionLabel ? { versionLabel: resource.versionLabel } : {}),
  }));
}

export interface ContextResourceManifestItem {
  reference: ContextResourceReference;
  label: string;
  sourceLabel: string;
  state: ContextResourceState;
  provider?: string;
  versionLabel?: string;
  scope?: string;
  reason?: ContextResourceReason;
  contentChars?: number;
}

export interface ContextResourceManifest {
  version: 1;
  items: ContextResourceManifestItem[];
}

export const MAX_CONTEXT_RESOURCE_REFERENCES = 8;

const RESOURCE_ID_MAX = 1_024;

export function parseContextResourceReferences(
  value: unknown,
): ContextResourceReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const parsed: ContextResourceReference[] = [];
  for (const candidate of value) {
    const reference = parseContextResourceReference(candidate);
    if (!reference) continue;
    const key = contextResourceReferenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(reference);
    if (parsed.length >= MAX_CONTEXT_RESOURCE_REFERENCES) break;
  }
  return parsed;
}

export function parseContextResourceManifest(
  value: unknown,
): ContextResourceManifest | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) {
    return null;
  }
  const items = value.items.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const reference = parseContextResourceReference(candidate.reference);
    if (
      !reference ||
      typeof candidate.label !== "string" ||
      typeof candidate.sourceLabel !== "string" ||
      !isContextResourceState(candidate.state)
    ) {
      return [];
    }
    const reason = isContextResourceReason(candidate.reason)
      ? candidate.reason
      : undefined;
    return [
      {
        reference,
        label: candidate.label.slice(0, 240),
        sourceLabel: candidate.sourceLabel.slice(0, 120),
        state: candidate.state,
        ...(typeof candidate.provider === "string"
          ? { provider: candidate.provider.slice(0, 80) }
          : {}),
        ...(typeof candidate.versionLabel === "string"
          ? { versionLabel: candidate.versionLabel.slice(0, 80) }
          : {}),
        ...(typeof candidate.scope === "string"
          ? { scope: candidate.scope.slice(0, 160) }
          : {}),
        ...(reason ? { reason } : {}),
        ...(typeof candidate.contentChars === "number" &&
        Number.isFinite(candidate.contentChars) &&
        candidate.contentChars >= 0
          ? { contentChars: Math.floor(candidate.contentChars) }
          : {}),
      } satisfies ContextResourceManifestItem,
    ];
  });
  return { version: 1, items };
}

export function contextResourceReferenceKey(
  reference: ContextResourceReference,
): string {
  return [reference.kind, reference.containerId ?? "", reference.resourceId].join(
    ":",
  );
}

export function contextResourceReceiptSummary(
  manifest: ContextResourceManifest,
): string {
  const included = manifest.items.filter((item) => item.state === "included");
  const attention = manifest.items.length - included.length;
  if (included.length === 0) {
    return attention > 0
      ? `${attention} selected ${attention === 1 ? "resource needs" : "resources need"} attention`
      : "No selected resources";
  }

  const counts = new Map<string, number>();
  for (const item of included) {
    const label = receiptGroupLabel(item);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const groups = [...counts].map(([label, count]) =>
    count === 1 && !label.endsWith("file") ? label : `${count} ${pluralize(label, count)}`,
  );
  const base = `Using ${formatList(groups)}`;
  return attention > 0
    ? `${base} · ${attention} ${attention === 1 ? "item needs" : "items need"} attention`
    : base;
}

export function contextResourceStateLabel(
  item: ContextResourceManifestItem,
): string {
  if (item.state === "included") return "Included";
  if (item.state === "discoverable-not-mounted") return "Not mounted";
  if (item.state === "policy-blocked") return "Blocked by policy";
  if (item.state === "budget-omitted") {
    return item.reason === "oversize"
      ? "Resource is too large"
      : "Omitted for context budget";
  }
  if (item.state === "generated-during-run") return "Generated during run";
  if (item.reason === "missing_connection") return "Connection missing";
  if (item.reason === "reconnect_required") return "Reconnect required";
  if (item.reason === "temporarily_unavailable") return "Temporarily unavailable";
  if (item.reason === "stale_version") return "Version is stale";
  if (item.reason === "extraction_failed") return "Extraction failed";
  return "Unavailable";
}

export function contextResourceSearchResultsFromManifest(
  references: readonly ContextResourceReference[] | undefined,
  manifest: ContextResourceManifest | undefined,
): ContextResourceSearchResult[] {
  const manifestByKey = new Map(
    (manifest?.items ?? []).map((item) => [
      contextResourceReferenceKey(item.reference),
      item,
    ]),
  );
  const selectedReferences =
    references ?? manifest?.items.map((item) => item.reference) ?? [];
  return selectedReferences.map((reference) => {
    const item = manifestByKey.get(contextResourceReferenceKey(reference));
    return {
      reference,
      label: item?.label ?? fallbackResourceLabel(reference),
      description: item?.scope ?? "Selected context",
      sourceLabel: item?.sourceLabel ?? fallbackResourceSource(reference),
      ...(item?.provider ? { provider: item.provider } : {}),
      ...(item?.versionLabel ? { versionLabel: item.versionLabel } : {}),
    };
  });
}

function parseContextResourceReference(
  value: unknown,
): ContextResourceReference | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isContextResourceKind(value.kind) ||
    typeof value.resourceId !== "string"
  ) {
    return null;
  }
  const resourceId = value.resourceId.trim();
  if (!resourceId || resourceId.length > RESOURCE_ID_MAX) return null;
  const containerId =
    typeof value.containerId === "string" ? value.containerId.trim() : "";
  if (containerId.length > RESOURCE_ID_MAX) return null;
  if (value.kind === "google_mail_thread" && !containerId) return null;
  return {
    version: 1,
    kind: value.kind,
    resourceId,
    ...(containerId ? { containerId } : {}),
  };
}

function receiptGroupLabel(item: ContextResourceManifestItem): string {
  if (item.reference.kind === "artifact") return "file";
  if (item.reference.kind === "vault_item") return "Vault memory";
  if (item.reference.kind === "app_version") return "app version";
  if (item.reference.kind === "google_mail_thread") return "Gmail thread";
  return item.sourceLabel;
}

function fallbackResourceLabel(reference: ContextResourceReference): string {
  if (reference.kind === "artifact") return "Selected file";
  if (reference.kind === "vault_item") return "Selected memory";
  if (reference.kind === "app_version") return "Selected app version";
  return "Selected Gmail thread";
}

function fallbackResourceSource(reference: ContextResourceReference): string {
  if (reference.kind === "artifact") return "Artifact";
  if (reference.kind === "vault_item") return "Vault";
  if (reference.kind === "app_version") return "App";
  return "Gmail";
}

function pluralize(label: string, count: number): string {
  if (count === 1) return label;
  if (label === "Vault memory") return "Vault memories";
  if (label.endsWith("s")) return label;
  return `${label}s`;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "no resources";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function isContextResourceKind(value: unknown): value is ContextResourceKind {
  return (CONTEXT_RESOURCE_KINDS as readonly unknown[]).includes(value);
}

function isContextResourceState(value: unknown): value is ContextResourceState {
  return (CONTEXT_RESOURCE_STATES as readonly unknown[]).includes(value);
}

function isContextResourceReason(value: unknown): value is ContextResourceReason {
  return (CONTEXT_RESOURCE_REASONS as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
