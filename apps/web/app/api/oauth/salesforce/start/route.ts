import { AuthConfigError } from "@ai-workspace/auth";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { PUBLIC_BASE_URL, STATE_TTL_SECONDS } from "@/lib/oauth/github";
import {
  SALESFORCE_AUTHORIZE_URL,
  SALESFORCE_CLIENT_ID,
  SALESFORCE_OAUTH_SCOPE,
  SALESFORCE_OAUTH_STATE_COOKIE,
  SALESFORCE_PROVIDER,
  SALESFORCE_REDIRECT_URI,
} from "@/lib/oauth/salesforce";

export const dynamic = "force-dynamic";

function chatRedirect(params: Record<string, string>) {
  const url = new URL("/chat", PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString(), { status: 302 });
}

export async function GET() {
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

  if (!SALESFORCE_CLIENT_ID) {
    return chatRedirect({
      connected: SALESFORCE_PROVIDER,
      error: "config_error",
    });
  }

  const state = randomBytes(32).toString("base64url");
  const authorize = new URL(SALESFORCE_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", SALESFORCE_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", SALESFORCE_REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", SALESFORCE_OAUTH_SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "login consent");

  const res = NextResponse.redirect(authorize.toString(), { status: 302 });
  res.cookies.set(SALESFORCE_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}
