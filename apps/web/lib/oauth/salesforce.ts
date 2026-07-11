import { PUBLIC_BASE_URL } from "@/lib/oauth/github";

export const SALESFORCE_PROVIDER = "salesforce";
export const SALESFORCE_CLIENT_ID = process.env.SALESFORCE_CLIENT_ID ?? "";

// login.salesforce.com for production orgs; override for sandboxes
// (test.salesforce.com) or a My Domain host.
export const SALESFORCE_LOGIN_URL = (
  process.env.SALESFORCE_LOGIN_URL ?? "https://login.salesforce.com"
).replace(/\/+$/, "");

export const SALESFORCE_REDIRECT_URI = `${PUBLIC_BASE_URL}/api/oauth/salesforce/callback`;
export const SALESFORCE_AUTHORIZE_URL = `${SALESFORCE_LOGIN_URL}/services/oauth2/authorize`;
export const SALESFORCE_TOKEN_URL = `${SALESFORCE_LOGIN_URL}/services/oauth2/token`;
export const SALESFORCE_OAUTH_STATE_COOKIE = "salesforce_oauth_state";

// Read-only integration: "api" grants REST/SOQL access bounded by the user's
// own Salesforce permissions; "refresh_token" enables offline refresh. There
// is deliberately no write tooling in v1 — see issue #358.
export const SALESFORCE_OAUTH_SCOPES = ["api", "refresh_token"] as const;
export const SALESFORCE_OAUTH_SCOPE = SALESFORCE_OAUTH_SCOPES.join(" ");

/**
 * Salesforce token responses carry the per-user API host (`instance_url`).
 * Only accept hosts that are unambiguously Salesforce-operated so a tampered
 * token response can never redirect API calls to an attacker origin.
 */
export function isTrustedSalesforceInstanceUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "salesforce.com" ||
    host.endsWith(".salesforce.com") ||
    host.endsWith(".force.com")
  );
}
