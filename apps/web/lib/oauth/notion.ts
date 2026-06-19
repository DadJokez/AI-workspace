import { PUBLIC_BASE_URL } from "@/lib/oauth/github";

export const NOTION_PROVIDER = "notion";
export const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID ?? "";

export const NOTION_REDIRECT_URI = `${PUBLIC_BASE_URL}/api/oauth/notion/callback`;
export const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";
export const NOTION_API_VERSION =
  process.env.NOTION_API_VERSION ?? "2026-03-11";

export const NOTION_STATE_COOKIE = "notion_oauth_state";
