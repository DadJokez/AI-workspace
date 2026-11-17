import { PUBLIC_BASE_URL } from "@/lib/deployment-config";

export const GITHUB_PROVIDER = "github";
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";

export const GITHUB_REDIRECT_URI = `${PUBLIC_BASE_URL}/api/oauth/github/callback`;
export const GITHUB_SCOPE = "repo read:user";
export const GITHUB_AUTHORIZE_URL =
  "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL =
  "https://github.com/login/oauth/access_token";

export const STATE_COOKIE = "gh_oauth_state";
export const STATE_TTL_SECONDS = 10 * 60;
