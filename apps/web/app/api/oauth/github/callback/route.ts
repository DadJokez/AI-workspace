import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { storeOAuthConnection } from "@/lib/oauth/connection";
import {
  GITHUB_CLIENT_ID,
  GITHUB_PROVIDER,
  GITHUB_REDIRECT_URI,
  GITHUB_TOKEN_URL,
  PUBLIC_BASE_URL,
  STATE_COOKIE,
} from "@/lib/oauth/github";

export const dynamic = "force-dynamic";

interface GitHubTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function settingsRedirect(_req: Request, params: Record<string, string>) {
  const url = new URL("/chat", PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url.toString(), { status: 302 });
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const ghError = url.searchParams.get("error");

  if (ghError) {
    return settingsRedirect(req, { connected: "github", error: ghError });
  }
  if (!code || !state) {
    return settingsRedirect(req, {
      connected: "github",
      error: "missing_code_or_state",
    });
  }

  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieState = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);

  if (!cookieState || cookieState !== state) {
    return settingsRedirect(req, {
      connected: "github",
      error: "invalid_state",
    });
  }

  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientSecret) {
    return NextResponse.json(
      { error: "config_error", message: "GITHUB_CLIENT_SECRET is not set" },
      { status: 500 },
    );
  }

  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      client_secret: clientSecret,
      code,
      redirect_uri: GITHUB_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    return settingsRedirect(req, {
      connected: "github",
      error: "token_exchange_failed",
    });
  }

  const tokenJson = (await tokenRes.json()) as GitHubTokenResponse;
  if (tokenJson.error || !tokenJson.access_token) {
    return settingsRedirect(req, {
      connected: "github",
      error: tokenJson.error ?? "no_access_token",
    });
  }

  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000)
    : null;

  await storeOAuthConnection({
    userId: sessionUser.id,
    provider: GITHUB_PROVIDER,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? null,
    expiresAt,
    scope: tokenJson.scope ?? null,
    attestationReason: "Approved during GitHub tool connection.",
    attestationSource: "github_oauth_callback",
  });

  return settingsRedirect(req, { connected: "github" });
}
