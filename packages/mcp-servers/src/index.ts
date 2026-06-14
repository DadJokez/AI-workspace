export {
  workfrontServer,
  start as startWorkfront,
} from "./workfront";
export {
  databricksServer,
  start as startDatabricks,
} from "./databricks";
export {
  teamsServer,
  start as startTeams,
} from "./teams";

import { databricksServer } from "./databricks";
import { teamsServer } from "./teams";
import { workfrontServer } from "./workfront";
import type { PlaceholderMcpServerConfig } from "./types";

/**
 * Convenience: every placeholder server in registration order. Hand to
 * the MCP registry once a real implementation is wired in.
 */
export const ALL_PLACEHOLDER_SERVERS: readonly PlaceholderMcpServerConfig[] = [
  workfrontServer,
  databricksServer,
  teamsServer,
];
