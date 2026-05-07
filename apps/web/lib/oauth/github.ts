export const GITHUB_PROVIDER = "github";
export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";

/**
 * Public origin of the deployed app. Hardcoded — must NOT be derived from
 * `req.url` or `Host` headers. Inside the App Runner container, the server
 * binds to 0.0.0.0:3000 and `req.url` resolves against that, which would
 * leak `http://0.0.0.0:3000/...` into Location headers we send to browsers.
 */
export const PUBLIC_BASE_URL =
  "https://vacwacwrxu.us-east-1.awsapprunner.com";
export const GITHUB_REDIRECT_URI = `${PUBLIC_BASE_URL}/api/oauth/github/callback`;
export const GITHUB_SCOPE = "repo read:user";
export const GITHUB_AUTHORIZE_URL =
  "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL =
  "https://github.com/login/oauth/access_token";

export const STATE_COOKIE = "gh_oauth_state";
export const STATE_TTL_SECONDS = 10 * 60;
