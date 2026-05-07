import { AuthConfigError } from "@ai-workspace/auth";
import { getDb, oauthTokens } from "@ai-workspace/db";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { encryptSecret } from "@/lib/oauth/crypto";
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

  const accessTokenEnc = encryptSecret(tokenJson.access_token);
  const refreshTokenEnc = tokenJson.refresh_token
    ? encryptSecret(tokenJson.refresh_token)
    : null;
  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000)
    : null;

  const db = getDb();
  await db
    .insert(oauthTokens)
    .values({
      userId: sessionUser.id,
      provider: GITHUB_PROVIDER,
      accessToken: accessTokenEnc,
      refreshToken: refreshTokenEnc,
      expiresAt,
      scope: tokenJson.scope ?? null,
    })
    .onConflictDoUpdate({
      target: [oauthTokens.userId, oauthTokens.provider],
      set: {
        accessToken: accessTokenEnc,
        refreshToken: refreshTokenEnc,
        expiresAt,
        scope: tokenJson.scope ?? null,
        updatedAt: sql`now()`,
      },
    });

  return settingsRedirect(req, { connected: "github" });
}
