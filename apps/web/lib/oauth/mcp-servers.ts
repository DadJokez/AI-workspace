import type { Database } from "@ai-workspace/db";
import { oauthTokens } from "@ai-workspace/db";
import type { McpServerSpec } from "@ai-workspace/cursor-runtime";
import { eq } from "drizzle-orm";

import { decryptSecret } from "./crypto";

const MCP_ENDPOINTS: Record<string, { url: string }> = {
  github: { url: "https://api.githubcopilot.com/mcp/" },
  // notion / google land here when their OAuth flows ship.
};

/**
 * Look up the user's connected providers from `oauth_tokens` and return a
 * Cursor-SDK `mcpServers` map keyed by provider name. The access token is
 * decrypted in process and passed as a Bearer header.
 *
 * Graceful degradation: any DB / decrypt / unsupported-provider error for a
 * single row is logged and skipped. The chat turn proceeds without that
 * provider. Total failure (e.g. DB unreachable) returns undefined and the
 * caller runs MCP-less.
 */
export async function buildUserMcpServers(
  db: Database,
  userId: string,
): Promise<Record<string, McpServerSpec> | undefined> {
  let rows;
  try {
    rows = await db
      .select({
        provider: oauthTokens.provider,
        accessToken: oauthTokens.accessToken,
      })
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId));
  } catch (err) {
    console.warn("[mcp] oauth_tokens lookup failed:", err);
    return undefined;
  }

  const out: Record<string, McpServerSpec> = {};
  for (const row of rows) {
    const endpoint = MCP_ENDPOINTS[row.provider];
    if (!endpoint) continue;
    let token: string;
    try {
      token = decryptSecret(row.accessToken);
    } catch (err) {
      console.warn(`[mcp] decrypt failed for ${row.provider}:`, err);
      continue;
    }
    out[row.provider] = {
      type: "http",
      url: endpoint.url,
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
