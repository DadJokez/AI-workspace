/**
 * Deployment-specific inputs: where this app is reachable. Everything here
 * comes from the environment so the same build runs in any account or network.
 */

import { GITHUB_DOT_COM } from "@ai-workspace/agent/sources";

const LOCAL_BASE_URL = "http://localhost:3000";
const GITHUB_DOT_COM_MCP_URL = "https://api.githubcopilot.com/mcp/";
const NEXT_BUILD_PHASE = "phase-production-build";

type Env = Record<string, string | undefined>;

/** Every connector this build knows how to offer. */
export const CONNECTOR_PROVIDERS = [
  "github",
  "notion",
  "google",
  "salesforce",
] as const;

const ANALYTICS_PROVIDERS = ["none", "posthog"] as const;
type AnalyticsProvider = (typeof ANALYTICS_PROVIDERS)[number];

const GITHUB_EVENT_INGEST_MODES = ["webhook", "poll"] as const;
export type GitHubEventIngestMode = (typeof GITHUB_EVENT_INGEST_MODES)[number];

export type DeploymentConfig = {
  publicBaseUrl: string | null;
  internalBaseUrl: string | null;
  enabledConnectorProviders: string[];
  webFetchEnabled: boolean;
  /** Null when analytics is off or its settings are incomplete. */
  analytics: { provider: "posthog"; token: string; host: string } | null;
  github: {
    /** Sign-in, OAuth consent and repository pages. */
    webUrl: string;
    /** REST API base, without a trailing slash. */
    apiUrl: string;
    /** Null when this deployment has no GitHub MCP server to mount. */
    mcpUrl: string | null;
  };
  /** How GitHub events reach event triggers. */
  githubEventIngestMode: GitHubEventIngestMode;
  problems: string[];
};

/** Pure reader so the rules can be tested without reloading the module. */
export function readDeploymentConfig(env: Env): DeploymentConfig {
  const problems: string[] = [];
  const production = env.NODE_ENV === "production";

  let publicBaseUrl: string | null = null;
  const rawPublic = env.NEXTAUTH_URL?.trim();
  if (rawPublic) {
    publicBaseUrl = parseBaseUrl(rawPublic);
    if (!publicBaseUrl) {
      problems.push("NEXTAUTH_URL must be an absolute http(s) URL");
    }
  } else if (production) {
    problems.push("NEXTAUTH_URL is required in production");
  } else {
    publicBaseUrl = LOCAL_BASE_URL;
  }

  let internalBaseUrl: string | null = null;
  const rawInternal = env.INTERNAL_BASE_URL?.trim();
  if (rawInternal) {
    internalBaseUrl = parseBaseUrl(rawInternal);
    if (!internalBaseUrl) {
      problems.push("INTERNAL_BASE_URL must be an absolute http(s) URL");
    }
  }

  if (env.BEDROCK_CLIENT === "real" && !env.AWS_REGION?.trim()) {
    problems.push("AWS_REGION is required when BEDROCK_CLIENT=real");
  }

  // Unset or blank means every connector, so an empty variable cannot remove
  // them all by accident.
  let enabledConnectorProviders: string[] = [...CONNECTOR_PROVIDERS];
  if (env.ENABLED_CONNECTOR_PROVIDERS?.trim()) {
    const requested = env.ENABLED_CONNECTOR_PROVIDERS.split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const known: readonly string[] = CONNECTOR_PROVIDERS;
    const unknown = requested.filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      problems.push(
        `ENABLED_CONNECTOR_PROVIDERS names unknown providers: ${unknown.join(", ")}`,
      );
    }
    enabledConnectorProviders = known.filter((name) => requested.includes(name));
  }

  const rawWebFetch = env.WEB_FETCH_ENABLED?.trim();
  if (rawWebFetch && rawWebFetch !== "0" && rawWebFetch !== "1") {
    problems.push("WEB_FETCH_ENABLED must be 0 or 1");
  }

  const rawAnalytics = env.ANALYTICS_PROVIDER?.trim().toLowerCase();
  let analyticsProvider: AnalyticsProvider = "none";
  if (rawAnalytics) {
    if ((ANALYTICS_PROVIDERS as readonly string[]).includes(rawAnalytics)) {
      analyticsProvider = rawAnalytics as AnalyticsProvider;
    } else {
      problems.push("ANALYTICS_PROVIDER must be none or posthog");
    }
  }
  let analytics: DeploymentConfig["analytics"] = null;
  if (analyticsProvider === "posthog") {
    const token = env.POSTHOG_PROJECT_TOKEN?.trim();
    const host = parseBaseUrl(env.POSTHOG_HOST?.trim() ?? "");
    if (!token) {
      problems.push(
        "POSTHOG_PROJECT_TOKEN is required when ANALYTICS_PROVIDER=posthog",
      );
    }
    if (!host) {
      problems.push(
        "POSTHOG_HOST must be an absolute http(s) URL when ANALYTICS_PROVIDER=posthog",
      );
    }
    if (token && host) analytics = { provider: "posthog", token, host };
  }

  // A typo must not silently pick a mode: it is reported, and webhook (today's
  // behaviour) stays in force.
  const rawIngestMode = env.GITHUB_EVENT_INGEST_MODE?.trim().toLowerCase();
  let githubEventIngestMode: GitHubEventIngestMode = "webhook";
  if (rawIngestMode) {
    if (
      (GITHUB_EVENT_INGEST_MODES as readonly string[]).includes(rawIngestMode)
    ) {
      githubEventIngestMode = rawIngestMode as GitHubEventIngestMode;
    } else {
      problems.push("GITHUB_EVENT_INGEST_MODE must be webhook or poll");
    }
  }

  return {
    publicBaseUrl,
    internalBaseUrl,
    enabledConnectorProviders,
    // Anything but an explicit 0 keeps the tool, so a typo cannot remove it.
    webFetchEnabled: rawWebFetch !== "0",
    analytics,
    github: readGitHubHosts(env, problems),
    githubEventIngestMode,
    problems,
  };
}

/**
 * Unset or blank web and API URLs mean github.com.
 *
 * GITHUB_MCP_URL is the one variable where unset and empty differ. Unset
 * (undefined) means the github.com default. Set but blank means this
 * deployment has no GitHub MCP server, so the connector mounts no tools. A
 * test that wants the default must leave the variable undefined
 * (`vi.stubEnv("GITHUB_MCP_URL", undefined)`) and not stub it to "".
 *
 * A GitHub Enterprise deployment has to name all three: left to a default, an
 * enterprise token would be sent to a github.com host. "Enterprise" means a
 * value that differs from github.com, not merely a variable being present:
 * GitHub Actions sets GITHUB_API_URL itself on every runner, and that ambient
 * github.com value must not read as a half-finished enterprise configuration.
 */
function readGitHubHosts(
  env: Env,
  problems: string[],
): DeploymentConfig["github"] {
  const rawWeb = env.GITHUB_WEB_URL?.trim();
  const rawApi = env.GITHUB_API_URL?.trim();
  const rawMcp = env.GITHUB_MCP_URL?.trim();

  let webUrl = GITHUB_DOT_COM.webUrl;
  if (rawWeb) {
    const parsed = parseBaseUrl(rawWeb);
    if (parsed) webUrl = parsed;
    else problems.push("GITHUB_WEB_URL must be an absolute http(s) URL");
  }
  let apiUrl = GITHUB_DOT_COM.apiUrl;
  if (rawApi) {
    const parsed = parseBaseUrl(rawApi);
    if (parsed) apiUrl = parsed;
    else problems.push("GITHUB_API_URL must be an absolute http(s) URL");
  }
  let mcpUrl: string | null = GITHUB_DOT_COM_MCP_URL;
  if (rawMcp === "") {
    mcpUrl = null;
  } else if (rawMcp) {
    // Kept as written: a trailing slash is part of an MCP endpoint's path.
    if (parseBaseUrl(rawMcp)) mcpUrl = rawMcp;
    else {
      problems.push("GITHUB_MCP_URL must be an absolute http(s) URL or empty");
    }
  }

  const enterprise =
    webUrl !== GITHUB_DOT_COM.webUrl || apiUrl !== GITHUB_DOT_COM.apiUrl;
  if (enterprise) {
    if (!rawWeb || !rawApi) {
      problems.push("GITHUB_WEB_URL and GITHUB_API_URL must be set together");
    }
    if (rawMcp === undefined) {
      problems.push(
        "GITHUB_MCP_URL must be set, or empty, when GITHUB_WEB_URL and GITHUB_API_URL are set",
      );
      mcpUrl = null;
    }
  }
  return { webUrl, apiUrl, mcpUrl };
}

function parseBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const config = readDeploymentConfig(process.env);

/**
 * Public origin of the deployed app, without a trailing slash. This must NOT
 * be derived from `req.url` or `Host` headers; those can point at the internal
 * container bind address and leak bad redirects into Location headers we send
 * to browsers.
 *
 * There is no fallback origin in production: a missing or malformed
 * NEXTAUTH_URL fails at load. `next build` evaluates route modules without the
 * runtime environment, so the build phase alone gets the local placeholder.
 */
export const PUBLIC_BASE_URL: string = resolvePublicBaseUrl();

function resolvePublicBaseUrl(): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  if (process.env.NEXT_PHASE === NEXT_BUILD_PHASE) return LOCAL_BASE_URL;
  throw new Error(
    `Invalid deployment configuration: ${config.problems
      .filter((problem) => problem.startsWith("NEXTAUTH_URL"))
      .join("; ")}`,
  );
}

/**
 * Address of this app on the private network, when the deployment has one.
 * A malformed value reads as null here (so the internal host is refused) and
 * is reported by `assertDeploymentConfig()` at boot.
 */
export const INTERNAL_BASE_URL: string | null = config.internalBaseUrl;

/**
 * The address a server-side caller (worker, AgentCore runtime) uses to reach
 * this app. Anything a browser follows must keep using `PUBLIC_BASE_URL`.
 */
export function serverCallbackBaseUrl(): string {
  return INTERNAL_BASE_URL ?? PUBLIC_BASE_URL;
}

/**
 * Stored URLs that point at this app are kept as a path (`/api/mcp/google`)
 * so the row is valid in any deployment. Resolve one for display; absolute
 * URLs pass through.
 */
export function resolveAppRelativeUrl(value: string): string {
  return value.startsWith("/") ? `${PUBLIC_BASE_URL}${value}` : value;
}

/**
 * Connectors this deployment offers. A provider left out is absent everywhere:
 * its routes return 404, it has no settings card, and the assistant is never
 * told it exists.
 */
export const ENABLED_CONNECTOR_PROVIDERS: readonly string[] =
  config.enabledConnectorProviders;

export function isConnectorProviderEnabled(provider: string): boolean {
  return ENABLED_CONNECTOR_PROVIDERS.includes(provider);
}

/**
 * Route guard: a 404 for a connector this deployment has turned off, null
 * otherwise. Its OAuth and facade routes answer as if they did not exist.
 */
export function disabledConnectorResponse(provider: string): Response | null {
  return isConnectorProviderEnabled(provider)
    ? null
    : new Response(null, { status: 404 });
}

/** False when the deployment removes the public URL fetch tool. */
export const WEB_FETCH_ENABLED: boolean = config.webFetchEnabled;

/**
 * Product analytics for this deployment, or null when it is off. Read at
 * runtime: nothing about analytics is baked into the image.
 */
export const ANALYTICS: DeploymentConfig["analytics"] = config.analytics;

/** GitHub in the browser: sign-in, OAuth consent and repository pages. */
export const GITHUB_WEB_URL: string = config.github.webUrl;

/** GitHub REST API base, without a trailing slash. */
export const GITHUB_API_URL: string = config.github.apiUrl;

/**
 * GitHub MCP endpoint, or null when the deployment has none. With null the
 * connector can still be linked but mounts no tools in chat.
 */
export const GITHUB_MCP_URL: string | null = config.github.mcpUrl;

/**
 * `webhook`: GitHub posts events to this app, which needs a public address.
 * `poll`: the chat worker reads each repository's events feed with the trigger
 * owner's token, and the webhook route answers 404.
 */
export const GITHUB_EVENT_INGEST_MODE: GitHubEventIngestMode =
  config.githubEventIngestMode;

/** True for the public host and, when configured, the internal host. */
export function isAllowedAppHost(host: string): boolean {
  const candidate = host.trim().toLowerCase();
  if (!candidate) return false;
  if (candidate === new URL(PUBLIC_BASE_URL).host.toLowerCase()) return true;
  return (
    INTERNAL_BASE_URL !== null &&
    candidate === new URL(INTERNAL_BASE_URL).host.toLowerCase()
  );
}

/** Throws one error naming every missing or malformed variable. */
export function assertDeploymentConfig(env: Env = process.env): void {
  const { problems } = readDeploymentConfig(env);
  if (problems.length > 0) {
    throw new Error(`Invalid deployment configuration: ${problems.join("; ")}`);
  }
}
