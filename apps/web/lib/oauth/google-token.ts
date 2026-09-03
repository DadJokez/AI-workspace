import type { Database } from "@ai-workspace/db";
import { oauthTokens } from "@ai-workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";

import { decryptSecret, encryptSecret } from "./crypto";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_PROVIDER,
  GOOGLE_TOOL_SCOPES,
  GOOGLE_TOKEN_URL,
} from "./google";

const REFRESH_EARLY_MS = 60_000;

export type GoogleReconnectReason =
  | "insufficient_scope"
  | "missing_refresh_token"
  | "expired_grant"
  | "invalid_stored_token";

export type GoogleConnectionState =
  | { status: "not_connected"; connected: false; ready: false }
  | {
      status: "reconnect_required";
      connected: true;
      ready: false;
      reason: GoogleReconnectReason;
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
      grantedScopes: string[];
      expiresAt: Date | null;
    };

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

export async function resolveGoogleConnection(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<GoogleConnectionState> {
  const rows = await db
    .select({
      accessToken: oauthTokens.accessToken,
      refreshToken: oauthTokens.refreshToken,
      expiresAt: oauthTokens.expiresAt,
      scope: oauthTokens.scope,
    })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.userId, userId),
        eq(oauthTokens.provider, GOOGLE_PROVIDER),
        isNull(oauthTokens.revokedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { status: "not_connected", connected: false, ready: false };

  const grantedScopes = parseGoogleScopes(row.scope);
  if (!hasRequiredGoogleScopes(grantedScopes)) {
    return {
      status: "reconnect_required",
      connected: true,
      ready: false,
      reason: "insufficient_scope",
      grantedScopes,
    };
  }

  const expiresAt = toDate(row.expiresAt);
  if (!expiresAt || expiresAt.getTime() > now.getTime() + REFRESH_EARLY_MS) {
    try {
      return {
        status: "ready",
        connected: true,
        ready: true,
        accessToken: decryptSecret(row.accessToken),
        grantedScopes,
        expiresAt,
      };
    } catch {
      return reconnectRequired("invalid_stored_token", grantedScopes);
    }
  }

  if (!row.refreshToken) {
    return reconnectRequired("missing_refresh_token", grantedScopes);
  }

  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!GOOGLE_CLIENT_ID || !clientSecret) {
    return temporarilyUnavailable("config_error", grantedScopes);
  }

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(row.refreshToken);
  } catch {
    return reconnectRequired("invalid_stored_token", grantedScopes);
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
  } catch {
    return temporarilyUnavailable("token_refresh_failed", grantedScopes);
  }

  let tokenJson: GoogleTokenResponse;
  try {
    tokenJson = (await tokenResponse.json()) as GoogleTokenResponse;
  } catch {
    return temporarilyUnavailable("token_refresh_failed", grantedScopes);
  }

  if (!tokenResponse.ok || tokenJson.error || !tokenJson.access_token) {
    return tokenJson.error === "invalid_grant"
      ? reconnectRequired("expired_grant", grantedScopes)
      : temporarilyUnavailable("token_refresh_failed", grantedScopes);
  }

  const refreshedScopes = tokenJson.scope
    ? parseGoogleScopes(tokenJson.scope)
    : grantedScopes;
  if (!hasRequiredGoogleScopes(refreshedScopes)) {
    return reconnectRequired("insufficient_scope", refreshedScopes);
  }

  const refreshedExpiresAt = new Date(
    now.getTime() + Math.max(1, tokenJson.expires_in ?? 3600) * 1000,
  );
  const encryptedAccessToken = encryptSecret(tokenJson.access_token);
  await db
    .update(oauthTokens)
    .set({
      accessToken: encryptedAccessToken,
      expiresAt: refreshedExpiresAt,
      scope: refreshedScopes.join(" "),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(oauthTokens.userId, userId),
        eq(oauthTokens.provider, GOOGLE_PROVIDER),
      ),
    );

  return {
    status: "ready",
    connected: true,
    ready: true,
    accessToken: tokenJson.access_token,
    grantedScopes: refreshedScopes,
    expiresAt: refreshedExpiresAt,
  };
}

export function parseGoogleScopes(value: string | null | undefined): string[] {
  return Array.from(
    new Set(
      (value ?? "")
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  );
}

export function hasRequiredGoogleScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return GOOGLE_TOOL_SCOPES.every((scope) => granted.has(scope));
}

function reconnectRequired(
  reason: GoogleReconnectReason,
  grantedScopes: string[],
): GoogleConnectionState {
  return {
    status: "reconnect_required",
    connected: true,
    ready: false,
    reason,
    grantedScopes,
  };
}

function temporarilyUnavailable(
  reason: "config_error" | "token_refresh_failed",
  grantedScopes: string[],
): GoogleConnectionState {
  return {
    status: "temporarily_unavailable",
    connected: true,
    ready: false,
    reason,
    grantedScopes,
  };
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
