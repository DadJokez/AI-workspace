import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { PUBLIC_BASE_URL, STATE_TTL_SECONDS } from "@/lib/oauth/github";
import {
  NOTION_AUTHORIZE_URL,
  NOTION_CLIENT_ID,
  NOTION_PROVIDER,
  NOTION_REDIRECT_URI,
  NOTION_STATE_COOKIE,
} from "@/lib/oauth/notion";

export const dynamic = "force-dynamic";

function chatRedirect(params: Record<string, string>) {
  const url = new URL("/chat", PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString(), { status: 302 });
}

export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  if (!NOTION_CLIENT_ID) {
    return chatRedirect({ connected: NOTION_PROVIDER, error: "config_error" });
  }

  const state = randomBytes(32).toString("base64url");
  const authorize = new URL(NOTION_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", NOTION_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", NOTION_REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("owner", "user");
  authorize.searchParams.set("state", state);

  const res = NextResponse.redirect(authorize.toString(), { status: 302 });
  res.cookies.set(NOTION_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}
