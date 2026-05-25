export const GITHUB_PROVIDER = "github";
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";

/**
 * Public origin of the deployed app. This must NOT be derived from `req.url`
 * or `Host` headers; those can point at the internal container bind address
 * and leak bad redirects into Location headers we send to browsers.
 */
const DEFAULT_PUBLIC_BASE_URL = "https://ai-workspace.builtwithrobot.link";
export const PUBLIC_BASE_URL =
  process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? DEFAULT_PUBLIC_BASE_URL;
export const GITHUB_REDIRECT_URI = `${PUBLIC_BASE_URL}/api/oauth/github/callback`;
export const GITHUB_SCOPE = "repo read:user";
export const GITHUB_AUTHORIZE_URL =
  "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL =
  "https://github.com/login/oauth/access_token";

export const STATE_COOKIE = "gh_oauth_state";
export const STATE_TTL_SECONDS = 10 * 60;
