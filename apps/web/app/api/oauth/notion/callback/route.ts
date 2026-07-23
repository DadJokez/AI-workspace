import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { PUBLIC_BASE_URL } from "@/lib/oauth/github";
import { storeOAuthConnection } from "@/lib/oauth/connection";
import {
  NOTION_API_VERSION,
  NOTION_CLIENT_ID,
  NOTION_PROVIDER,
  NOTION_REDIRECT_URI,
  NOTION_STATE_COOKIE,
  NOTION_TOKEN_URL,
} from "@/lib/oauth/notion";

export const dynamic = "force-dynamic";

interface NotionTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string;
  error?: string;
  error_description?: string;
}

function settingsRedirect(_req: Request, params: Record<string, string>) {
  const url = new URL("/chat", PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url.toString(), { status: 302 });
  res.cookies.set(NOTION_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const notionError = url.searchParams.get("error");

  if (notionError) {
    return settingsRedirect(req, {
      connected: NOTION_PROVIDER,
      error: notionError,
    });
  }
  if (!code || !state) {
    return settingsRedirect(req, {
      connected: NOTION_PROVIDER,
      error: "missing_code_or_state",
    });
  }

  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieState = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${NOTION_STATE_COOKIE}=`))
    ?.slice(NOTION_STATE_COOKIE.length + 1);

  if (!cookieState || cookieState !== state) {
    return settingsRedirect(req, {
      connected: NOTION_PROVIDER,
      error: "invalid_state",
    });
  }

  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  if (!NOTION_CLIENT_ID || !clientSecret) {
    return settingsRedirect(req, {
      connected: NOTION_PROVIDER,
      error: "config_error",
    });
  }

  const basicAuth = Buffer.from(`${NOTION_CLIENT_ID}:${clientSecret}`).toString(
    "base64",
  );
  const tokenRes = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: NOTION_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    return settingsRedirect(req, {
      connected: NOTION_PROVIDER,
      error: "token_exchange_failed",
    });
  }

  const tokenJson = (await tokenRes.json()) as NotionTokenResponse;
  if (tokenJson.error || !tokenJson.access_token) {
    return settingsRedirect(req, {
      connected: NOTION_PROVIDER,
      error: tokenJson.error ?? "no_access_token",
    });
  }

  const expiresAt = tokenJson.expires_in
    ? new Date(Date.now() + tokenJson.expires_in * 1000)
    : null;
  const scope = buildNotionScope(tokenJson);

  await storeOAuthConnection({
    userId: sessionUser.id,
    provider: NOTION_PROVIDER,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token ?? null,
    expiresAt,
    scope,
    attestationReason: "Approved during Notion tool connection.",
    attestationSource: "notion_oauth_callback",
  });

  return settingsRedirect(req, { connected: NOTION_PROVIDER });
}

function buildNotionScope(token: NotionTokenResponse): string | null {
  const parts = [
    token.workspace_id ? `workspace:${token.workspace_id}` : "",
    token.workspace_name ? `name:${token.workspace_name}` : "",
    token.bot_id ? `bot:${token.bot_id}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}
