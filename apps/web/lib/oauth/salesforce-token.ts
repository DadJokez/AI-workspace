import type { Database } from "@ai-workspace/db";
import { oauthTokens } from "@ai-workspace/db";
import { and, eq, sql } from "drizzle-orm";

import { decryptSecret, encryptSecret } from "./crypto";
import {
  SALESFORCE_CLIENT_ID,
  SALESFORCE_PROVIDER,
  SALESFORCE_TOKEN_URL,
  isTrustedSalesforceInstanceUrl,
} from "./salesforce";

/**
 * Salesforce token responses carry no expires_in; access-token lifetime
 * follows the org's session policy (defaults measured in hours). Refresh on a
 * conservative fixed cadence instead of trusting an unknown policy.
 */
export const SALESFORCE_ACCESS_TOKEN_TTL_MS = 25 * 60 * 1000;
const REFRESH_EARLY_MS = 60_000;

export type SalesforceReconnectReason =
  | "insufficient_scope"
  | "missing_refresh_token"
  | "expired_grant"
  | "invalid_stored_token"
  | "missing_instance_url";

export type SalesforceConnectionState =
  | { status: "not_connected"; connected: false; ready: false }
  | {
      status: "reconnect_required";
      connected: true;
      ready: false;
      reason: SalesforceReconnectReason;
      grantedScopes: string[];
    }
  | {
      status: "temporarily_unavailable";
      connected: true;
      ready: false;
      reason: "config_error" | "token_refresh_failed";
      grantedScopes: string[];
    }
  | {
      status: "ready";
      connected: true;
      ready: true;
      accessToken: string;
      instanceUrl: string;
      grantedScopes: string[];
      expiresAt: Date | null;
    };

interface SalesforceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  scope?: string;
  error?: string;
}

export async function resolveSalesforceConnection(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<SalesforceConnectionState> {
  const rows = await db
    .select({
      accessToken: oauthTokens.accessToken,
      refreshToken: oauthTokens.refreshToken,
      expiresAt: oauthTokens.expiresAt,
      scope: oauthTokens.scope,
      providerMetadata: oauthTokens.providerMetadata,
    })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.userId, userId),
        eq(oauthTokens.provider, SALESFORCE_PROVIDER),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { status: "not_connected", connected: false, ready: false };

  const grantedScopes = parseSalesforceScopes(row.scope);
  if (!grantedScopes.includes("api")) {
    return {
      status: "reconnect_required",
      connected: true,
      ready: false,
      reason: "insufficient_scope",
      grantedScopes,
    };
  }

  const instanceUrl = readInstanceUrl(row.providerMetadata);
  if (!instanceUrl) {
    return {
      status: "reconnect_required",
      connected: true,
      ready: false,
      reason: "missing_instance_url",
      grantedScopes,
    };
  }

  const expiresAt = toDate(row.expiresAt);
  if (expiresAt && expiresAt.getTime() > now.getTime() + REFRESH_EARLY_MS) {
    const accessToken = tryDecrypt(row.accessToken);
    if (!accessToken) {
      return {
        status: "reconnect_required",
        connected: true,
        ready: false,
        reason: "invalid_stored_token",
        grantedScopes,
      };
    }
    return {
      status: "ready",
      connected: true,
      ready: true,
      accessToken,
      instanceUrl,
      grantedScopes,
      expiresAt,
    };
  }

  const refreshToken = row.refreshToken ? tryDecrypt(row.refreshToken) : null;
  if (!refreshToken) {
    return {
      status: "reconnect_required",
      connected: true,
      ready: false,
      reason: row.refreshToken ? "invalid_stored_token" : "missing_refresh_token",
      grantedScopes,
    };
  }

  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  if (!SALESFORCE_CLIENT_ID || !clientSecret) {
    return {
      status: "temporarily_unavailable",
      connected: true,
      ready: false,
      reason: "config_error",
      grantedScopes,
    };
  }

  let refreshRes: Response;
  try {
    refreshRes = await fetch(SALESFORCE_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: SALESFORCE_CLIENT_ID,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });
  } catch {
    return {
      status: "temporarily_unavailable",
      connected: true,
      ready: false,
      reason: "token_refresh_failed",
      grantedScopes,
    };
  }

  const refreshJson = (await refreshRes
    .json()
    .catch(() => ({}))) as SalesforceTokenResponse;

  if (!refreshRes.ok || refreshJson.error || !refreshJson.access_token) {
    // invalid_grant means the refresh token itself was revoked or expired —
    // the user must reconnect. Anything else is treated as transient.
    if (refreshJson.error === "invalid_grant") {
      return {
        status: "reconnect_required",
        connected: true,
        ready: false,
        reason: "expired_grant",
        grantedScopes,
      };
    }
    return {
      status: "temporarily_unavailable",
      connected: true,
      ready: false,
      reason: "token_refresh_failed",
      grantedScopes,
    };
  }

  const refreshedInstanceUrl =
    refreshJson.instance_url &&
    isTrustedSalesforceInstanceUrl(refreshJson.instance_url)
      ? refreshJson.instance_url.replace(/\/+$/, "")
      : instanceUrl;
  const newExpiresAt = new Date(now.getTime() + SALESFORCE_ACCESS_TOKEN_TTL_MS);
  const newScope = refreshJson.scope ?? row.scope;

  await db
    .update(oauthTokens)
    .set({
      accessToken: encryptSecret(refreshJson.access_token),
      ...(refreshJson.refresh_token
        ? { refreshToken: encryptSecret(refreshJson.refresh_token) }
        : {}),
      expiresAt: newExpiresAt,
      scope: newScope,
      providerMetadata: { instanceUrl: refreshedInstanceUrl },
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(oauthTokens.userId, userId),
        eq(oauthTokens.provider, SALESFORCE_PROVIDER),
      ),
    );

  return {
    status: "ready",
    connected: true,
    ready: true,
    accessToken: refreshJson.access_token,
    instanceUrl: refreshedInstanceUrl,
    grantedScopes: parseSalesforceScopes(newScope),
    expiresAt: newExpiresAt,
  };
}

function parseSalesforceScopes(scope: string | null | undefined): string[] {
  return (scope ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readInstanceUrl(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as Record<string, unknown>).instanceUrl;
  if (typeof value !== "string" || !isTrustedSalesforceInstanceUrl(value)) {
    return null;
  }
  return value.replace(/\/+$/, "");
}

function tryDecrypt(value: string): string | null {
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
