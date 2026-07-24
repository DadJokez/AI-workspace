import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { PUBLIC_BASE_URL } from "@/lib/oauth/github";
import { storeOAuthConnection } from "@/lib/oauth/connection";
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_PROVIDER,
  GOOGLE_REDIRECT_URI,
  GOOGLE_TOKEN_URL,
} from "@/lib/oauth/google";

export const dynamic = "force-dynamic";

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

function settingsRedirect(_req: Request, params: Record<string, string>) {
  const url = new URL("/chat", PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url.toString(), { status: 302 });
  res.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  if (googleError) {
    return settingsRedirect(req, {
      connected: GOOGLE_PROVIDER,
      error: googleError,
    });
  }
  if (!code || !state) {
    return settingsRedirect(req, {
      connected: GOOGLE_PROVIDER,
      error: "missing_code_or_state",
    });
  }

  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieState = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`))
    ?.slice(GOOGLE_OAUTH_STATE_COOKIE.length + 1);

  if (!cookieState || cookieState !== state) {
    return settingsRedirect(req, {
      connected: GOOGLE_PROVIDER,
      error: "invalid_state",
    });
  }

  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!GOOGLE_CLIENT_ID || !clientSecret) {
    return settingsRedirect(req, {
      connected: GOOGLE_PROVIDER,
      error: "config_error",
    });
  }

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: GOOGLE_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    return settingsRedirect(req, {
      connected: GOOGLE_PROVIDER,
      error: "token_exchange_failed",
    });
  }

  const tokenJson = (await tokenRes.json()) as GoogleTokenResponse;
  if (tokenJson.error || !tokenJson.access_token) {
    return settingsRedirect(req, {
      connected: GOOGLE_PROVIDER,
      error: tokenJson.error ?? "no_access_token",
    });
  }

  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000)
    : null;

  await storeOAuthConnection({
    userId: sessionUser.id,
    provider: GOOGLE_PROVIDER,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? null,
    expiresAt,
    // Scope sufficiency is an authorization boundary. Never record requested
    // scopes as granted when Google did not return an authoritative list.
    scope: tokenJson.scope ?? null,
    attestationAction: "write",
    attestationReason: "Approved during Google Mail and Calendar connection.",
    attestationSource: "google_oauth_callback",
  });

  return settingsRedirect(req, { connected: GOOGLE_PROVIDER });
}
