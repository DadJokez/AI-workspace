import type { DataBinding } from "@/lib/app-data-bindings";

/**
 * Fail-closed provider gate for live (viewer-identity) app bindings (#802).
 *
 * A provider may carry a live binding only when it satisfies all three of
 * the properties the viewer-identity rule depends on:
 *
 *  - `perUserCredential` — every viewer authenticates with their OWN stored
 *    grant (an `oauth_tokens` row per user), never a shared service
 *    principal, so the source enforces its own entitlements per viewer;
 *  - `connectCta` — the product has a Connect path (a Settings →
 *    Integrations card, see `INTEGRATION_DISPLAY_NAMES`), so an unconnected
 *    viewer gets an honest connect prompt instead of anyone else's data;
 *  - `audit` — every refresh is written per viewer (`app_data_refresh`).
 *
 * A provider absent from this table — a future service-principal data lake,
 * for instance — cannot be published live at all: the publish-time check
 * refuses it, so the viewer-identity default cannot erode as providers are
 * added (the ThoughtSpot "no rules = see everything" anti-pattern, inverted).
 * Adding a provider here is a deliberate, reviewed statement that all three
 * properties hold. Client-safe: constants and pure predicates only.
 */
export interface ViewerIdentityProviderSupport {
  perUserCredential: boolean;
  connectCta: boolean;
  audit: boolean;
}

export const VIEWER_IDENTITY_BINDING_PROVIDERS: Readonly<
  Record<string, ViewerIdentityProviderSupport>
> = {
  salesforce: { perUserCredential: true, connectCta: true, audit: true },
  github: { perUserCredential: true, connectCta: true, audit: true },
  google: { perUserCredential: true, connectCta: true, audit: true },
  notion: { perUserCredential: true, connectCta: true, audit: true },
};

export function providerSupportsViewerIdentity(provider: string): boolean {
  const support = VIEWER_IDENTITY_BINDING_PROVIDERS[provider];
  return (
    support !== undefined &&
    support.perUserCredential &&
    support.connectCta &&
    support.audit
  );
}

/** The `tools_catalog` columns the read-only check depends on. */
export interface BindingCatalogEntry {
  enabled: boolean;
  action: "read" | "write" | "admin";
  policy: "always_allow" | "needs_approval" | "blocked";
}

/**
 * A binding may only ever target an enabled catalog READ tool whose runtime
 * policy is `always_allow` — never a write, never anything that would need
 * approval or is blocked. Checked at publish and again at serve/fetch so an
 * admin reclassifying a tool after publish stops live data immediately.
 */
export function isReadOnlyCatalogEntry(
  entry: BindingCatalogEntry | null | undefined,
): boolean {
  return (
    entry !== null &&
    entry !== undefined &&
    entry.enabled &&
    entry.action === "read" &&
    entry.policy === "always_allow"
  );
}

export type BindingGateReason =
  | "provider_not_viewer_identity"
  | "provider_execution_unavailable"
  | "tool_not_cataloged"
  | "tool_not_read_only";

/**
 * Pure publish-time verdict for one binding. `null` means publishable.
 * Order matters for the message a builder sees: an ineligible provider is
 * the fundamental problem, then deployment configuration, then the tool.
 */
export function evaluateBindingGate(
  binding: Pick<DataBinding, "provider" | "toolName">,
  {
    catalogEntry,
    executionConfigured,
  }: {
    catalogEntry: BindingCatalogEntry | null;
    executionConfigured: boolean;
  },
): BindingGateReason | null {
  if (!providerSupportsViewerIdentity(binding.provider)) {
    return "provider_not_viewer_identity";
  }
  if (!executionConfigured) return "provider_execution_unavailable";
  if (!catalogEntry) return "tool_not_cataloged";
  if (!isReadOnlyCatalogEntry(catalogEntry)) return "tool_not_read_only";
  return null;
}

export function describeBindingGateReason(
  binding: Pick<DataBinding, "id" | "provider" | "toolName">,
  reason: BindingGateReason,
): string {
  const target = `${binding.provider}/${binding.toolName} (binding "${binding.id}")`;
  switch (reason) {
    case "provider_not_viewer_identity":
      return `${target} cannot be published live: ${binding.provider} does not support per-viewer credentials, a connect prompt, and per-viewer audit. Publish this version as a snapshot instead.`;
    case "provider_execution_unavailable":
      return `${target} cannot be published live: this deployment cannot execute ${binding.provider} tools. Publish this version as a snapshot instead.`;
    case "tool_not_cataloged":
      return `${target} cannot be published live: the tool is not in the workspace tool catalog.`;
    case "tool_not_read_only":
      return `${target} cannot be published live: only enabled, always-allowed read tools can back a live binding.`;
  }
}
