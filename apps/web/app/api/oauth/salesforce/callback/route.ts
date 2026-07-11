import { AuthConfigError } from "@ai-workspace/auth";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { PUBLIC_BASE_URL } from "@/lib/oauth/github";
import { storeOAuthConnection } from "@/lib/oauth/connection";
import {
  SALESFORCE_CLIENT_ID,
  SALESFORCE_OAUTH_STATE_COOKIE,
  SALESFORCE_PROVIDER,
  SALESFORCE_REDIRECT_URI,
  SALESFORCE_TOKEN_URL,
  isTrustedSalesforceInstanceUrl,
} from "@/lib/oauth/salesforce";
import { SALESFORCE_ACCESS_TOKEN_TTL_MS } from "@/lib/oauth/salesforce-token";

export const dynamic = "force-dynamic";

interface SalesforceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  scope?: string;
  token_type?: string;
  issued_at?: string;
  error?: string;
  error_description?: string;
}

function settingsRedirect(_req: Request, params: Record<string, string>) {
  const url = new URL("/chat", PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url.toString(), { status: 302 });
  res.cookies.set(SALESFORCE_OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  let sessionUser;
  try {
    sessionUser = await getSessionUser();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const salesforceError = url.searchParams.get("error");

  if (salesforceError) {
    return settingsRedirect(req, {
      connected: SALESFORCE_PROVIDER,
      error: salesforceError,
    });
  }
  if (!code || !state) {
    return settingsRedirect(req, {
      connected: SALESFORCE_PROVIDER,
      error: "missing_code_or_state",
    });
  }

  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieState = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SALESFORCE_OAUTH_STATE_COOKIE}=`))
    ?.slice(SALESFORCE_OAUTH_STATE_COOKIE.length + 1);

  if (!cookieState || cookieState !== state) {
    return settingsRedirect(req, {
      connected: SALESFORCE_PROVIDER,
      error: "invalid_state",
    });
  }

  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  if (!SALESFORCE_CLIENT_ID || !clientSecret) {
    return settingsRedirect(req, {
      connected: SALESFORCE_PROVIDER,
      error: "config_error",
    });
  }

  const tokenRes = await fetch(SALESFORCE_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: SALESFORCE_CLIENT_ID,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: SALESFORCE_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    return settingsRedirect(req, {
      connected: SALESFORCE_PROVIDER,
      error: "token_exchange_failed",
    });
  }

  const tokenJson = (await tokenRes.json()) as SalesforceTokenResponse;
  if (tokenJson.error || !tokenJson.access_token) {
    return settingsRedirect(req, {
      connected: SALESFORCE_PROVIDER,
      error: tokenJson.error ?? "no_access_token",
    });
  }

  // The instance_url is where every subsequent API call is sent. Reject
  // anything that is not an https Salesforce-operated host outright.
  if (
    !tokenJson.instance_url ||
    !isTrustedSalesforceInstanceUrl(tokenJson.instance_url)
  ) {
    return settingsRedirect(req, {
      connected: SALESFORCE_PROVIDER,
      error: "untrusted_instance_url",
    });
  }

  // Salesforce access tokens carry no expires_in; lifetime follows the org's
  // session policy. Use a conservative fixed TTL so the token layer refreshes
  // well before typical session timeouts.
  const expiresAt = new Date(Date.now() + SALESFORCE_ACCESS_TOKEN_TTL_MS);

  await storeOAuthConnection({
    userId: sessionUser.id,
    provider: SALESFORCE_PROVIDER,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? null,
    expiresAt,
    // Scope sufficiency is an authorization boundary. Never record requested
    // scopes as granted when Salesforce did not return an authoritative list.
    scope: tokenJson.scope ?? null,
    providerMetadata: {
      instanceUrl: tokenJson.instance_url.replace(/\/+$/, ""),
    },
    attestationAction: "read",
    attestationReason: "Approved during Salesforce connection (read-only).",
    attestationSource: "salesforce_oauth_callback",
  });

  return settingsRedirect(req, { connected: SALESFORCE_PROVIDER });
}
