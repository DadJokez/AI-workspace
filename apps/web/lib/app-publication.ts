import { toolsCatalog, type Database } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import {
  parseDataBindings,
  type DataBinding,
} from "@/lib/app-data-bindings";

export const APP_PUBLICATION_SCHEMA = "app-publication.v1";

export type AppPublicationDataMode =
  | "snapshot"
  | "live_via_viewer"
  | "service_backed";
export type SelectableAppPublicationDataMode = Exclude<
  AppPublicationDataMode,
  "service_backed"
>;
export type AppPublicationAudience = "private" | "named";

export interface AppConnectorManifestEntry {
  provider: string;
  toolName: string;
  catalogKey: string;
  bindingIds: string[];
}

export interface AppPublicationMetadata {
  schema: typeof APP_PUBLICATION_SCHEMA;
  dataMode: AppPublicationDataMode;
  publishedAt: string;
  publishedByUserId: string;
  audience: AppPublicationAudience;
  connectorManifest: AppConnectorManifestEntry[];
}

export interface ResolvedAppPublication {
  metadata: AppPublicationMetadata;
  legacyInferred: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isDataMode(value: unknown): value is AppPublicationDataMode {
  return (
    value === "snapshot" ||
    value === "live_via_viewer" ||
    value === "service_backed"
  );
}

function parseConnectorManifest(value: unknown): AppConnectorManifestEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AppConnectorManifestEntry[] = [];
  for (const candidate of value) {
    const row = asRecord(candidate);
    if (
      !row ||
      typeof row.provider !== "string" ||
      typeof row.toolName !== "string" ||
      typeof row.catalogKey !== "string" ||
      !Array.isArray(row.bindingIds)
    ) {
      continue;
    }
    const bindingIds = row.bindingIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    entries.push({
      provider: row.provider,
      toolName: row.toolName,
      catalogKey: row.catalogKey,
      bindingIds,
    });
  }
  return entries;
}

export function parseRequestedPublicationMode(
  value: unknown,
): SelectableAppPublicationDataMode | null {
  if (value === undefined || value === null || value === "") return "snapshot";
  return value === "snapshot" || value === "live_via_viewer" ? value : null;
}

export function connectorManifestForBindings(
  bindings: readonly DataBinding[],
): AppConnectorManifestEntry[] {
  const grouped = new Map<string, AppConnectorManifestEntry>();
  for (const binding of bindings) {
    const toolName = binding.provider === "salesforce" ? "run_soql" : "";
    if (!toolName) continue;
    const catalogKey = `${binding.provider}:${toolName}`;
    const existing = grouped.get(catalogKey);
    if (existing) {
      existing.bindingIds.push(binding.id);
    } else {
      grouped.set(catalogKey, {
        provider: binding.provider,
        toolName,
        catalogKey,
        bindingIds: [binding.id],
      });
    }
  }
  return [...grouped.values()];
}

export function createAppPublicationMetadata({
  artifactMetadata,
  dataMode,
  publishedAt,
  publishedByUserId,
  audience,
}: {
  artifactMetadata: unknown;
  dataMode: SelectableAppPublicationDataMode;
  publishedAt: Date;
  publishedByUserId: string;
  audience: AppPublicationAudience;
}): AppPublicationMetadata {
  const bindings = parseDataBindings(artifactMetadata);
  if (dataMode === "live_via_viewer" && bindings.length === 0) {
    throw new Error(
      "Live via viewer requires at least one supported data binding.",
    );
  }
  return {
    schema: APP_PUBLICATION_SCHEMA,
    dataMode,
    publishedAt: publishedAt.toISOString(),
    publishedByUserId,
    audience,
    connectorManifest:
      dataMode === "live_via_viewer"
        ? connectorManifestForBindings(bindings)
        : [],
  };
}

export function stampAppPublicationMetadata(
  artifactMetadata: unknown,
  publication: AppPublicationMetadata,
): Record<string, unknown> {
  return {
    ...(asRecord(artifactMetadata) ?? {}),
    appPublication: publication,
  };
}

export function resolveAppPublication(
  artifactMetadata: unknown,
  fallbackPublishedAt = new Date(0),
  fallbackPublishedByUserId = "unknown",
): ResolvedAppPublication {
  const record = asRecord(artifactMetadata);
  const raw = asRecord(record?.appPublication);
  if (
    raw?.schema === APP_PUBLICATION_SCHEMA &&
    isDataMode(raw.dataMode) &&
    typeof raw.publishedAt === "string" &&
    typeof raw.publishedByUserId === "string" &&
    (raw.audience === "private" || raw.audience === "named")
  ) {
    return {
      metadata: {
        schema: APP_PUBLICATION_SCHEMA,
        dataMode: raw.dataMode,
        publishedAt: raw.publishedAt,
        publishedByUserId: raw.publishedByUserId,
        audience: raw.audience,
        connectorManifest: parseConnectorManifest(raw.connectorManifest),
      },
      legacyInferred: false,
    };
  }

  const bindings = parseDataBindings(artifactMetadata);
  return {
    metadata: {
      schema: APP_PUBLICATION_SCHEMA,
      dataMode: bindings.length > 0 ? "live_via_viewer" : "snapshot",
      publishedAt: fallbackPublishedAt.toISOString(),
      publishedByUserId: fallbackPublishedByUserId,
      audience: "private",
      connectorManifest: connectorManifestForBindings(bindings),
    },
    legacyInferred: true,
  };
}

export async function isPublicationManifestEnabled(
  db: Database,
  publication: AppPublicationMetadata,
): Promise<boolean> {
  if (publication.dataMode !== "live_via_viewer") return true;
  if (publication.connectorManifest.length === 0) return false;
  for (const entry of publication.connectorManifest) {
    const rows = await db
      .select({ enabled: toolsCatalog.enabled })
      .from(toolsCatalog)
      .where(
        and(
          eq(toolsCatalog.provider, entry.provider),
          eq(toolsCatalog.toolName, entry.toolName),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled !== true) return false;
  }
  return true;
}

export function isBindingIncludedInPublication(
  publication: AppPublicationMetadata,
  binding: Pick<DataBinding, "id" | "provider">,
): boolean {
  return publication.connectorManifest.some(
    (entry) =>
      entry.provider === binding.provider &&
      entry.bindingIds.includes(binding.id),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function injectAppPublicationBadge(
  html: string,
  {
    publication,
    authorName,
  }: {
    publication: AppPublicationMetadata;
    authorName: string;
  },
): string {
  const publishedAt = new Date(publication.publishedAt);
  const timestamp = Number.isNaN(publishedAt.getTime())
    ? "unknown"
    : publishedAt.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }) + " UTC";
  const modeLabel =
    publication.dataMode === "snapshot"
      ? `Snapshot · Published ${timestamp} · publish a new version to refresh`
      : publication.dataMode === "live_via_viewer"
        ? "Live via your connections"
        : "Service-backed";
  const badge = [
    '<aside id="comparative-publication-badge" aria-label="Comparative publication details"',
    ' style="box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;',
    "width:100%;min-height:34px;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.3);",
    "background:#101114;color:#f5f5f4;font:12px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
    'letter-spacing:0;position:relative;z-index:2147483647">',
    '<span style="font-weight:650;white-space:nowrap">Comparative</span>',
    `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b8bcc7">${escapeHtml(
      modeLabel,
    )}</span>`,
    `<span style="white-space:nowrap;color:#b8bcc7">By ${escapeHtml(authorName)}</span>`,
    "</aside>",
  ].join("");
  const bodyOpen = /<body[^>]*>/i.exec(html);
  if (!bodyOpen) return `${badge}\n${html}`;
  const at = bodyOpen.index + bodyOpen[0].length;
  return `${html.slice(0, at)}\n${badge}${html.slice(at)}`;
}
