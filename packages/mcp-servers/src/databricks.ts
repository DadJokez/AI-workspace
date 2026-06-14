import type { PlaceholderMcpServerConfig } from "./types";

/**
 * Databricks MCP server — placeholder.
 *
 * Surface this exposes when implemented:
 *   - databricks.run_sql            (against a whitelisted catalog/schema)
 *   - databricks.list_tables
 *   - databricks.describe_table
 *   - databricks.get_query_status   (for long-running jobs)
 *
 * Auth model: service-principal OAuth (M2M) for the workspace, with the
 * calling user's id passed through as a tag for audit. Per-user delegated
 * auth is a future option but adds significant token-management overhead.
 *
 * Open questions for promotion:
 *   - row-level guardrails: enforce in this server or via Unity Catalog?
 *   - cost ceiling per query — reject SQL whose explain plan exceeds N
 *     bytes scanned?
 */
export const databricksServer: PlaceholderMcpServerConfig = {
  name: "databricks",
  // command: "node",
  // args: ["./dist/databricks-server.js"],
  // env: {
  //   DATABRICKS_HOST: "...",
  //   DATABRICKS_WAREHOUSE_ID: "...",
  // },
};

export function start(): never {
  throw new Error(
    "databricks MCP server: placeholder. See packages/mcp-servers/README.md.",
  );
}
