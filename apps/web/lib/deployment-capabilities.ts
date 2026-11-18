import { isWebSearchConfigured } from "@ai-workspace/agent/web-search-tool";
import {
  CONNECTOR_PROVIDERS,
  ENABLED_CONNECTOR_PROVIDERS,
  GITHUB_MCP_URL,
  WEB_FETCH_ENABLED,
} from "@/lib/deployment-config";

/**
 * What this deployment can do at all, before any user connects anything. The
 * assistant's capability statement is built from it, so a capability the
 * deployment removes is one the assistant is never told it has.
 */
export interface DeploymentCapabilities {
  /** Connectors on offer. */
  connectors: readonly string[];
  /** Known connectors this deployment has turned off. */
  disabledConnectors: readonly string[];
  /**
   * Connectors on offer that mount no tools in chat here, whether or not a
   * user has linked an account (GitHub with no MCP server configured).
   */
  connectorsWithoutChatTools: readonly string[];
  webSearch: boolean;
  webFetch: boolean;
}

/** Every capability present: the shape of a deployment with nothing removed. */
export const FULL_DEPLOYMENT_CAPABILITIES: DeploymentCapabilities = {
  connectors: CONNECTOR_PROVIDERS,
  disabledConnectors: [],
  connectorsWithoutChatTools: [],
  webSearch: true,
  webFetch: true,
};

export function deploymentCapabilities(): DeploymentCapabilities {
  return {
    connectors: ENABLED_CONNECTOR_PROVIDERS,
    disabledConnectors: CONNECTOR_PROVIDERS.filter(
      (provider) => !ENABLED_CONNECTOR_PROVIDERS.includes(provider),
    ),
    connectorsWithoutChatTools: ENABLED_CONNECTOR_PROVIDERS.filter(
      (provider) => provider === "github" && GITHUB_MCP_URL === null,
    ),
    webSearch: isWebSearchConfigured(),
    webFetch: WEB_FETCH_ENABLED,
  };
}
