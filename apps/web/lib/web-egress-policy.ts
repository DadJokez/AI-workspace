import {
  WEB_EGRESS_POLICY_NAME,
  type WebEgressPolicy,
} from "@ai-workspace/agent/web-egress-policy";
import { type Database, toolsCatalog } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";

export const WEB_EGRESS_SETTINGS_PROVIDER = "builtin";
export const WEB_EGRESS_SETTINGS_TOOL = "__web_egress_policy__";

export const DEFAULT_WEB_EGRESS_POLICY: WebEgressPolicy = {
  name: WEB_EGRESS_POLICY_NAME,
  deniedDomains: [],
};

export async function loadWebEgressPolicy(
  db: Database,
): Promise<WebEgressPolicy> {
  const rows = await db
    .select({ metadata: toolsCatalog.metadata })
    .from(toolsCatalog)
    .where(
      and(
        eq(toolsCatalog.provider, WEB_EGRESS_SETTINGS_PROVIDER),
        eq(toolsCatalog.toolName, WEB_EGRESS_SETTINGS_TOOL),
      ),
    )
    .limit(1);

  return policyFromMetadata(rows[0]?.metadata);
}

export async function saveWebEgressPolicy(
  db: Database,
  deniedDomains: readonly string[],
): Promise<WebEgressPolicy> {
  const policy: WebEgressPolicy = {
    name: WEB_EGRESS_POLICY_NAME,
    deniedDomains: normalizeDeniedDomains(deniedDomains),
  };
  const now = new Date();
  await db
    .insert(toolsCatalog)
    .values({
      provider: WEB_EGRESS_SETTINGS_PROVIDER,
      toolName: WEB_EGRESS_SETTINGS_TOOL,
      displayName: "Web egress policy",
      description:
        "Admin-global deny-wins domain policy for built-in web tools.",
      category: "policy",
      action: "admin",
      requiresAttestation: false,
      enabled: true,
      metadata: policy,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [toolsCatalog.provider, toolsCatalog.toolName],
      set: { metadata: policy, updatedAt: now },
    });
  return policy;
}

export function parseDeniedDomainInput(
  value: unknown,
): { ok: true; domains: string[] } | { ok: false; invalid: string[] } {
  if (!Array.isArray(value)) return { ok: false, invalid: ["denylist"] };

  const invalid: string[] = [];
  const domains: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      invalid.push(String(entry));
      continue;
    }
    const normalized = normalizeDomain(entry);
    if (!normalized) {
      invalid.push(entry);
      continue;
    }
    if (!domains.includes(normalized)) domains.push(normalized);
  }
  return invalid.length > 0
    ? { ok: false, invalid }
    : { ok: true, domains };
}

function policyFromMetadata(value: unknown): WebEgressPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_WEB_EGRESS_POLICY;
  }
  const deniedDomains = (value as { deniedDomains?: unknown }).deniedDomains;
  return {
    name: WEB_EGRESS_POLICY_NAME,
    deniedDomains: Array.isArray(deniedDomains)
      ? normalizeDeniedDomains(
          deniedDomains.filter(
            (domain): domain is string => typeof domain === "string",
          ),
        )
      : [],
  };
}

function normalizeDeniedDomains(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map(normalizeDomain)
        .filter((value): value is string => value !== null),
    ),
  ].sort();
}

function normalizeDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !candidate ||
    candidate.includes("/") ||
    candidate.includes(":") ||
    candidate.includes("*") ||
    /\s/.test(candidate)
  ) {
    return null;
  }
  try {
    const hostname = new URL(`https://${candidate}`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
    return hostname === candidate ? hostname : null;
  } catch {
    return null;
  }
}
