import { toolsCatalog, type Database } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { bindingCatalogKey, type DataBinding } from "@/lib/app-data-bindings";
import {
  describeBindingGateReason,
  evaluateBindingGate,
  type BindingCatalogEntry,
  type BindingGateReason,
} from "@/lib/app-binding-providers";
import { isMcpProviderExecutionConfigured } from "@/lib/oauth/mcp-servers";

/**
 * Server half of the #802 fail-closed provider gate: loads the catalog rows
 * a version's bindings point at and applies `evaluateBindingGate` to each.
 * Runs at publish time (`deployAppVersion`) so a live publication can never
 * declare a provider or tool the viewer-identity rule cannot honor.
 */
export class LiveBindingGateError extends Error {
  readonly code = "live_binding_not_publishable";

  constructor(
    readonly bindingId: string,
    readonly reason: BindingGateReason,
    message: string,
  ) {
    super(message);
    this.name = "LiveBindingGateError";
  }
}

export async function loadBindingCatalogEntries(
  db: Database,
  bindings: readonly Pick<DataBinding, "provider" | "toolName">[],
): Promise<Map<string, BindingCatalogEntry>> {
  const entries = new Map<string, BindingCatalogEntry>();
  for (const binding of bindings) {
    const key = bindingCatalogKey(binding);
    if (entries.has(key)) continue;
    const rows = await db
      .select({
        enabled: toolsCatalog.enabled,
        action: toolsCatalog.action,
        policy: toolsCatalog.policy,
      })
      .from(toolsCatalog)
      .where(
        and(
          eq(toolsCatalog.provider, binding.provider),
          eq(toolsCatalog.toolName, binding.toolName),
        ),
      )
      .limit(1);
    if (rows[0]) entries.set(key, rows[0]);
  }
  return entries;
}

export type LiveBindingGateResult =
  | { ok: true }
  | {
      ok: false;
      bindingId: string;
      reason: BindingGateReason;
      message: string;
    };

/** Every binding must pass; the first failure is reported. */
export async function checkLiveBindingsPublishable(
  db: Database,
  bindings: readonly DataBinding[],
): Promise<LiveBindingGateResult> {
  const catalog = await loadBindingCatalogEntries(db, bindings);
  for (const binding of bindings) {
    const reason = evaluateBindingGate(binding, {
      catalogEntry: catalog.get(bindingCatalogKey(binding)) ?? null,
      executionConfigured: isMcpProviderExecutionConfigured(binding.provider),
    });
    if (reason) {
      return {
        ok: false,
        bindingId: binding.id,
        reason,
        message: describeBindingGateReason(binding, reason),
      };
    }
  }
  return { ok: true };
}
