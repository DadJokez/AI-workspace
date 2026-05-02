import type { McpServerConfigStub } from "@ai-workspace/cursor-runtime";

/**
 * Microsoft Teams MCP server — placeholder.
 *
 * Surface this exposes when implemented:
 *   - teams.list_my_chats
 *   - teams.get_chat_messages
 *   - teams.search_messages
 *   - teams.post_message            (write-tier, opt-in via attestation)
 *
 * Auth model: per-user delegated Graph (Teams scopes). Reuses the same
 * Entra app registration / `oauth_tokens` infra as the Mail/Calendar
 * tools described in PLAN.md week 3. The MCP server is just a
 * different transport; the consent and token storage are shared.
 *
 * Open questions for promotion:
 *   - merge with the existing Graph tools (one server, all Graph
 *     resources) vs. keep Teams isolated for blast-radius reasons?
 *   - rate-limiting writes: per-user/hour cap on `post_message` to
 *     prevent runaway agent loops from spamming channels.
 */
export const teamsServer: McpServerConfigStub = {
  name: "teams",
  // command: "node",
  // args: ["./dist/teams-server.js"],
  // env: { GRAPH_BASE_URL: "https://graph.microsoft.com/v1.0" },
};

export function start(): never {
  throw new Error(
    "teams MCP server: placeholder. See packages/mcp-servers/README.md.",
  );
}
