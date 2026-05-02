import type { McpServerConfigStub } from "@ai-workspace/cursor-runtime";

/**
 * Workfront MCP server — placeholder.
 *
 * Surface this exposes when implemented (best guess; finalize when the
 * Workfront API tier is confirmed):
 *   - workfront.search_projects
 *   - workfront.get_task
 *   - workfront.list_my_assignments
 *   - workfront.add_comment
 *
 * Auth model: per-user OAuth (Workfront API v2). Tokens stored alongside
 * Graph tokens in the `oauth_tokens` table once that lands.
 *
 * Open questions for promotion:
 *   - stdio (local subprocess) vs. HTTP (deployed alongside the web app)?
 *   - per-user token isolation: pass via `env` here, or have the server
 *     resolve tokens from a header on each tool call?
 */
export const workfrontServer: McpServerConfigStub = {
  name: "workfront",
  // command: "node",
  // args: ["./dist/workfront-server.js"],
  // env: { WORKFRONT_BASE_URL: "https://gp.my.workfront.com" },
};

export function start(): never {
  throw new Error(
    "workfront MCP server: placeholder. See packages/mcp-servers/README.md.",
  );
}
