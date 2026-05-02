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

import type { McpServerConfigStub } from "@ai-workspace/cursor-runtime";
import { databricksServer } from "./databricks";
import { teamsServer } from "./teams";
import { workfrontServer } from "./workfront";

/**
 * Convenience: every placeholder server in registration order. Hand to
 * `new CursorRuntime({ mcpServers: ALL_PLACEHOLDER_SERVERS })` once a real
 * implementation is wired in.
 */
export const ALL_PLACEHOLDER_SERVERS: readonly McpServerConfigStub[] = [
  workfrontServer,
  databricksServer,
  teamsServer,
];
