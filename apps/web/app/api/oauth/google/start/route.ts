import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { PUBLIC_BASE_URL, STATE_TTL_SECONDS } from "@/lib/oauth/github";
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_OAUTH_SCOPE,
  GOOGLE_OAUTH_STATE_COOKIE,
  GOOGLE_PROVIDER,
  GOOGLE_REDIRECT_URI,
} from "@/lib/oauth/google";

export const dynamic = "force-dynamic";

function chatRedirect(params: Record<string, string>) {
  const url = new URL("/chat", PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString(), { status: 302 });
}

export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  if (!GOOGLE_CLIENT_ID) {
    return chatRedirect({ connected: GOOGLE_PROVIDER, error: "config_error" });
  }

  const state = randomBytes(32).toString("base64url");
  const authorize = new URL(GOOGLE_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", GOOGLE_OAUTH_SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("include_granted_scopes", "true");
  authorize.searchParams.set("prompt", "consent");

  const res = NextResponse.redirect(authorize.toString(), { status: 302 });
  res.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}
