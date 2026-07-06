import { PUBLIC_BASE_URL } from "@/lib/oauth/github";

export const GOOGLE_PROVIDER = "google";
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";

export const GOOGLE_REDIRECT_URI = `${PUBLIC_BASE_URL}/api/oauth/google/callback`;
export const GOOGLE_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;
export const GOOGLE_OAUTH_SCOPE = GOOGLE_OAUTH_SCOPES.join(" ");
