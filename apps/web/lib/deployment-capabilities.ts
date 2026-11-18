import { isWebSearchConfigured } from "@ai-workspace/agent/web-search-tool";
import {
  CONNECTOR_PROVIDERS,
  ENABLED_CONNECTOR_PROVIDERS,
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
  webSearch: boolean;
  webFetch: boolean;
}

/** Every capability present: the shape of a deployment with nothing removed. */
export const FULL_DEPLOYMENT_CAPABILITIES: DeploymentCapabilities = {
  connectors: CONNECTOR_PROVIDERS,
  disabledConnectors: [],
  webSearch: true,
  webFetch: true,
};

export function deploymentCapabilities(): DeploymentCapabilities {
  return {
    connectors: ENABLED_CONNECTOR_PROVIDERS,
    disabledConnectors: CONNECTOR_PROVIDERS.filter(
      (provider) => !ENABLED_CONNECTOR_PROVIDERS.includes(provider),
    ),
    webSearch: isWebSearchConfigured(),
    webFetch: WEB_FETCH_ENABLED,
  };
}
