import { AuthConfigError } from "@ai-workspace/auth";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  GITHUB_AUTHORIZE_URL,
  GITHUB_CLIENT_ID,
  GITHUB_REDIRECT_URI,
  GITHUB_SCOPE,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
} from "@/lib/oauth/github";

export const dynamic = "force-dynamic";

/**
 * GET /api/oauth/github/start — kick off the GitHub OAuth flow.
 * Sets a short-lived signed state cookie and redirects to GitHub's authorize URL.
 */
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

  const state = randomBytes(32).toString("base64url");

  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", GITHUB_REDIRECT_URI);
  authorize.searchParams.set("scope", GITHUB_SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");

  const res = NextResponse.redirect(authorize.toString(), { status: 302 });
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}
