import { responsesEndpointHost } from "@ai-workspace/agent";
import {
  BRAVE_ENDPOINT,
  isWebSearchConfigured,
} from "@ai-workspace/agent/web-search-tool";
import { enabledAuthProviders } from "@/lib/auth/nextauth";
import { sesEndpointHost, sesEnvConfig } from "@/lib/aws-ses";
import {
  ANALYTICS,
  CONNECTOR_PROVIDERS,
  ENABLED_CONNECTOR_PROVIDERS,
  GITHUB_API_URL,
  GITHUB_EVENT_INGEST_MODE,
  GITHUB_WEB_URL,
  INTERNAL_BASE_URL,
  OIDC,
  WEB_FETCH_ENABLED,
  readDeploymentConfig,
  serverCallbackBaseUrl,
} from "@/lib/deployment-config";
import {
  CALENDAR_API_BASE,
  GMAIL_API_BASE,
  GMAIL_WEB_URL,
} from "@/lib/google/api";
import { GOOGLE_AUTHORIZE_URL, GOOGLE_TOKEN_URL } from "@/lib/oauth/google";
import { mcpProviderEndpointUrl } from "@/lib/oauth/mcp-servers";
import { NOTION_AUTHORIZE_URL, NOTION_TOKEN_URL } from "@/lib/oauth/notion";
import {
  SALESFORCE_DEFAULT_LOGIN_URL,
  SALESFORCE_LOGIN_URL,
} from "@/lib/oauth/salesforce";
import { postHogUpstreamUrl } from "@/lib/posthog-ingest";
import { INTEGRATION_DISPLAY_NAMES } from "@/lib/settings-navigation";

/**
 * Every network destination this product reaches, for the firewall review and
 * the proxy allowlist (docs/security/EGRESS_INVENTORY.md is generated from it).
 *
 * Hosts come from the same constants and settings the calling code uses, so a
 * GitHub Enterprise host, a Salesforce sandbox or a second analytics region
 * shows up here without an edit, and a capability the deployment turns off
 * takes its rows with it. A host that is only a literal in the source is held
 * here by egress-inventory.test.ts, which scans for literals this list lacks.
 */

export type EgressService =
  | "web"
  | "chat-worker"
  | "memory-worker"
  | "agent-runtime"
  | "browser-proxy"
  | "browser";

export interface EgressEntry {
  /** Hostname. A leading `*.` covers subdomains; a bare `*` is any host. */
  host: string;
  purpose: string;
  /** Who connects. `browser` is the user's own browser, not a service of ours. */
  services: EgressService[];
  /** The setting that keeps this row; turning it off removes the row. */
  enabledWhen: string;
  /**
   * True when the request leaves through the forward proxy (HTTPS_PROXY) in a
   * firewalled deployment. False for hosts reached directly: AWS endpoints
   * that have a VPC endpoint, the internal address, and anything a browser
   * opens.
   */
  viaProxy: boolean;
}

/** The deployment facts the inventory depends on. */
export interface EgressSettings {
  region: string;
  /** Null when outbound email is off. */
  sesRegion: string | null;
  /** Host that workers and the agent runtime call this app on. */
  appHost: string;
  /** True when that host is the internal address, not the public one. */
  appHostInternal: boolean;
  connectors: readonly string[];
  githubSignIn: boolean;
  githubWebHost: string;
  githubApiHost: string;
  /** Host of OIDC_ISSUER; null when OIDC sign-in is off. */
  oidcIssuerHost: string | null;
  /** Event triggers read repository event feeds (GITHUB_EVENT_INGEST_MODE=poll). */
  githubEventPolling: boolean;
  /**
   * Connector MCP servers on a host other than this app, by connector. GitHub
   * is absent when the deployment has no GitHub MCP server.
   */
  externalMcpHosts: Readonly<Record<string, string>>;
  salesforceLoginHost: string;
  webSearch: boolean;
  webFetch: boolean;
  /** Chat runs execute in an AgentCore runtime. */
  agentCoreRuntime: boolean;
  studioBrowser: boolean;
  /** Analytics ingest and static-asset hosts; empty when analytics is off. */
  analyticsHosts: readonly string[];
}

/** Services that run the agent loop: model calls, MCP clients, web tools. */
const AGENT_LOOP: EgressService[] = ["web", "chat-worker", "agent-runtime"];
/** Services that resolve a user's connections and refresh their tokens. */
const TOKEN_REFRESH: EgressService[] = ["web", "chat-worker"];
const ECS_SERVICES: EgressService[] = [
  "web",
  "chat-worker",
  "memory-worker",
  "browser-proxy",
];

/**
 * Hosts an accepted Salesforce `instance_url` can name. Mirrors
 * `isTrustedSalesforceInstanceUrl`; the test checks the two agree.
 */
export const SALESFORCE_INSTANCE_HOSTS = ["*.salesforce.com", "*.force.com"];

/** Stands for "any public host" in a row. */
export const ANY_HOST = "*";
const ECS_CREDENTIALS_HOST = "169.254.170.2";
/** Linked from app/admin/InvitationsPanel.tsx. */
const GOOGLE_CLOUD_CONSOLE_HOST = "console.cloud.google.com";
/** `ui_host` in instrumentation-client.ts. */
const POSTHOG_UI_HOST = "us.posthog.com";

/** The SDK's default data-plane endpoint; next.config.mjs names it in the CSP. */
function agentCoreEndpointHost(region: string): string {
  return `bedrock-agentcore.${region}.amazonaws.com`;
}

/** What turns a connector's own MCP server on, beyond the connector itself. */
const MCP_SERVER_SETTING: Record<string, string> = {
  github: "GITHUB_MCP_URL not empty",
  notion: "NOTION_MCP_ENDPOINT_URL set",
};

function displayName(provider: string): string {
  const names: Record<string, string> = INTEGRATION_DISPLAY_NAMES;
  return names[provider] ?? provider;
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

function analyticsHosts(ingestHost: string): string[] {
  return [
    ...new Set([
      hostOf(ingestHost),
      hostOf(postHogUpstreamUrl(ingestHost, ["static"], "")),
    ]),
  ];
}

/** Pure: the rows for one set of deployment facts. */
export function buildEgressInventory(settings: EgressSettings): EgressEntry[] {
  const { region } = settings;
  const connector = (name: string) => settings.connectors.includes(name);
  const entries: EgressEntry[] = [
    {
      host: responsesEndpointHost(region),
      purpose: "Bedrock model inference",
      services: ["web", "chat-worker", "memory-worker", "agent-runtime"],
      enabledWhen: "always",
      viaProxy: false,
    },
    {
      host: `secretsmanager.${region}.amazonaws.com`,
      purpose: "Container platform: secrets injected at task start",
      services: ECS_SERVICES,
      enabledWhen: "always",
      viaProxy: false,
    },
    {
      host: `logs.${region}.amazonaws.com`,
      purpose: "Container platform: log delivery",
      services: ECS_SERVICES,
      enabledWhen: "always",
      viaProxy: false,
    },
    {
      host: ECS_CREDENTIALS_HOST,
      purpose: "Container platform: task role credentials (plain HTTP, link-local)",
      services: ["web", "chat-worker", "memory-worker"],
      enabledWhen: "always",
      viaProxy: false,
    },
    {
      host: settings.appHost,
      purpose:
        "This app: connector MCP facades, resource tools and run callbacks",
      services: ["chat-worker", "agent-runtime"],
      enabledWhen: "always (INTERNAL_BASE_URL moves it off the proxy)",
      viaProxy: !settings.appHostInternal,
    },
  ];

  if (settings.agentCoreRuntime || settings.studioBrowser) {
    entries.push({
      host: agentCoreEndpointHost(region),
      purpose:
        "AgentCore: runtime invocation, browser sessions, stored API keys",
      services: AGENT_LOOP,
      enabledWhen: "AGENTCORE_RUNTIME_ARN set or AGENTCORE_BROWSER_ENABLED=1",
      viaProxy: false,
    });
  }

  if (settings.sesRegion) {
    entries.push({
      host: sesEndpointHost(settings.sesRegion),
      // The SES API has no VPC interface endpoint, so unlike the other AWS
      // hosts it is reached through the proxy.
      purpose: "SES: sign-in links and invitation email",
      services: ["web"],
      enabledWhen: "INVITE_EMAIL_PROVIDER=ses",
      viaProxy: true,
    });
  }

  if (connector("github") || settings.githubSignIn) {
    const enabledWhen =
      "github in ENABLED_CONNECTOR_PROVIDERS or in AUTH_PROVIDERS";
    entries.push(
      {
        host: settings.githubWebHost,
        purpose: "GitHub OAuth token exchange (connector and sign-in)",
        services: ["web"],
        enabledWhen,
        viaProxy: true,
      },
      {
        host: settings.githubApiHost,
        purpose: "GitHub REST API: sign-in profile, webhook subscriptions",
        services: ["web"],
        enabledWhen,
        viaProxy: true,
      },
      {
        host: settings.githubWebHost,
        purpose: "GitHub sign-in and consent pages, links to cited sources",
        services: ["browser"],
        enabledWhen,
        viaProxy: false,
      },
    );
  }
  if (settings.oidcIssuerHost) {
    const enabledWhen = "pingone in AUTH_PROVIDERS";
    entries.push(
      {
        host: settings.oidcIssuerHost,
        // The discovery document names the other endpoints. An identity
        // provider that serves them from a second host needs that host too.
        purpose:
          "OIDC sign-in: discovery document, signing keys, token exchange, userinfo",
        services: ["web"],
        enabledWhen,
        viaProxy: true,
      },
      {
        host: settings.oidcIssuerHost,
        purpose: "OIDC sign-in page",
        services: ["browser"],
        enabledWhen,
        viaProxy: false,
      },
    );
  }
  if (connector("github") && settings.githubEventPolling) {
    entries.push({
      host: settings.githubApiHost,
      purpose:
        "GitHub REST API: repository event feeds and pull requests, read for event triggers",
      services: TOKEN_REFRESH,
      enabledWhen:
        "github in ENABLED_CONNECTOR_PROVIDERS and GITHUB_EVENT_INGEST_MODE=poll",
      viaProxy: true,
    });
  }
  for (const [provider, host] of Object.entries(settings.externalMcpHosts)) {
    if (!connector(provider)) continue;
    entries.push({
      host,
      purpose: `${displayName(provider)} MCP server: the connector's tools`,
      services: AGENT_LOOP,
      enabledWhen: `${provider} in ENABLED_CONNECTOR_PROVIDERS and ${MCP_SERVER_SETTING[provider] ?? "its MCP endpoint set"}`,
      viaProxy: true,
    });
  }

  if (connector("google")) {
    const enabledWhen = "google in ENABLED_CONNECTOR_PROVIDERS";
    entries.push(
      {
        host: hostOf(GOOGLE_TOKEN_URL),
        purpose: "Google OAuth token exchange and refresh",
        services: TOKEN_REFRESH,
        enabledWhen,
        viaProxy: true,
      },
      {
        host: hostOf(GMAIL_API_BASE),
        purpose: "Gmail API",
        services: ["web"],
        enabledWhen,
        viaProxy: true,
      },
      {
        host: hostOf(CALENDAR_API_BASE),
        purpose: "Google Calendar API",
        services: ["web"],
        enabledWhen,
        viaProxy: true,
      },
      {
        host: hostOf(GOOGLE_AUTHORIZE_URL),
        purpose: "Google consent page",
        services: ["browser"],
        enabledWhen,
        viaProxy: false,
      },
      {
        host: hostOf(GMAIL_WEB_URL),
        purpose: "Links to Gmail threads in answers",
        services: ["browser"],
        enabledWhen,
        viaProxy: false,
      },
      {
        host: GOOGLE_CLOUD_CONSOLE_HOST,
        purpose: "Admin link to the Google OAuth test-user list",
        services: ["browser"],
        enabledWhen,
        viaProxy: false,
      },
    );
  }

  if (connector("notion")) {
    const enabledWhen = "notion in ENABLED_CONNECTOR_PROVIDERS";
    entries.push(
      {
        host: hostOf(NOTION_TOKEN_URL),
        purpose: "Notion OAuth token exchange and API",
        services: ["web"],
        enabledWhen,
        viaProxy: true,
      },
      {
        host: hostOf(NOTION_AUTHORIZE_URL),
        purpose: "Notion consent page",
        services: ["browser"],
        enabledWhen,
        viaProxy: false,
      },
    );
  }

  if (connector("salesforce")) {
    const enabledWhen = "salesforce in ENABLED_CONNECTOR_PROVIDERS";
    entries.push(
      {
        host: settings.salesforceLoginHost,
        purpose: "Salesforce OAuth token exchange and refresh",
        services: TOKEN_REFRESH,
        enabledWhen,
        viaProxy: true,
      },
      ...SALESFORCE_INSTANCE_HOSTS.map((host) => ({
        host,
        purpose: "Salesforce API on the user's own instance",
        services: ["web"] as EgressService[],
        enabledWhen,
        viaProxy: true,
      })),
      {
        host: settings.salesforceLoginHost,
        purpose: "Salesforce consent page",
        services: ["browser"],
        enabledWhen,
        viaProxy: false,
      },
    );
  }

  if (settings.webSearch) {
    entries.push({
      host: hostOf(BRAVE_ENDPOINT),
      purpose: "Brave web search",
      services: AGENT_LOOP,
      enabledWhen: "WEB_SEARCH_PROVIDER=brave",
      viaProxy: true,
    });
  }
  if (settings.webFetch) {
    entries.push({
      host: ANY_HOST,
      purpose: "URL fetch tool: any public web page the user names",
      services: AGENT_LOOP,
      enabledWhen: "WEB_FETCH_ENABLED=1",
      viaProxy: true,
    });
  }

  if (settings.studioBrowser) {
    entries.push(
      {
        host: ANY_HOST,
        // The browser proxy opens its own connections; it does not read
        // HTTPS_PROXY.
        purpose: "Studio browser: any public site the remote browser opens",
        services: ["browser-proxy"],
        enabledWhen: "AGENTCORE_BROWSER_ENABLED=1",
        viaProxy: false,
      },
      {
        host: agentCoreEndpointHost(region),
        purpose: "Studio browser live view (HTTPS and WebSocket)",
        services: ["browser"],
        enabledWhen: "AGENTCORE_BROWSER_ENABLED=1",
        viaProxy: false,
      },
    );
  }

  if (settings.analyticsHosts.length > 0) {
    entries.push(
      ...settings.analyticsHosts.map((host) => ({
        host,
        purpose: "PostHog product analytics (browser events relay through /ingest)",
        services: ["web"] as EgressService[],
        enabledWhen: "ANALYTICS_PROVIDER=posthog",
        viaProxy: true,
      })),
      {
        host: POSTHOG_UI_HOST,
        purpose: "PostHog app links from its browser SDK; no request in normal use",
        services: ["browser"],
        enabledWhen: "ANALYTICS_PROVIDER=posthog",
        viaProxy: false,
      },
    );
  }

  return entries;
}

function deploymentEgressSettings(): EgressSettings {
  const ses = sesEnvConfig();
  const appUrl = serverCallbackBaseUrl();
  const appHost = hostOf(appUrl);
  const externalMcpHosts: Record<string, string> = {};
  for (const provider of ENABLED_CONNECTOR_PROVIDERS) {
    const endpoint = mcpProviderEndpointUrl(provider);
    if (endpoint && hostOf(endpoint) !== appHost) {
      externalMcpHosts[provider] = hostOf(endpoint);
    }
  }
  return {
    // Same fallback next.config.mjs and the Studio browser use.
    region:
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    sesRegion: ses.provider === "ses" ? ses.region : null,
    appHost,
    appHostInternal: INTERNAL_BASE_URL !== null,
    connectors: ENABLED_CONNECTOR_PROVIDERS,
    githubSignIn: enabledAuthProviders().includes("github"),
    githubWebHost: hostOf(GITHUB_WEB_URL),
    githubApiHost: hostOf(GITHUB_API_URL),
    oidcIssuerHost:
      OIDC && enabledAuthProviders().includes("pingone")
        ? hostOf(OIDC.issuer)
        : null,
    githubEventPolling: GITHUB_EVENT_INGEST_MODE === "poll",
    externalMcpHosts,
    salesforceLoginHost: hostOf(SALESFORCE_LOGIN_URL),
    webSearch: isWebSearchConfigured(),
    webFetch: WEB_FETCH_ENABLED,
    agentCoreRuntime: Boolean(process.env.AGENTCORE_RUNTIME_ARN),
    // The switch alone, not the full readiness check in studio-browser.ts:
    // a half-configured browser still belongs in the firewall request.
    studioBrowser: process.env.AGENTCORE_BROWSER_ENABLED === "1",
    analyticsHosts: ANALYTICS ? analyticsHosts(ANALYTICS.host) : [],
  };
}

/** This deployment's destinations, from its own environment. */
export const EGRESS_INVENTORY: EgressEntry[] = buildEgressInventory(
  deploymentEgressSettings(),
);

const DEFAULT_GITHUB = readDeploymentConfig({}).github;

/**
 * Everything switched on with default hosts and no region chosen. The
 * committed document is generated from this, so it lists every row any
 * deployment can have and does not change with the machine that builds it.
 */
export const REFERENCE_EGRESS_SETTINGS: EgressSettings = {
  region: "<region>",
  sesRegion: "<region>",
  appHost: "<this app>",
  appHostInternal: false,
  connectors: CONNECTOR_PROVIDERS,
  githubSignIn: true,
  githubWebHost: hostOf(DEFAULT_GITHUB.webUrl),
  githubApiHost: hostOf(DEFAULT_GITHUB.apiUrl),
  oidcIssuerHost: "<OIDC issuer>",
  githubEventPolling: true,
  externalMcpHosts: DEFAULT_GITHUB.mcpUrl
    ? { github: hostOf(DEFAULT_GITHUB.mcpUrl) }
    : {},
  salesforceLoginHost: hostOf(SALESFORCE_DEFAULT_LOGIN_URL),
  webSearch: true,
  webFetch: true,
  agentCoreRuntime: true,
  studioBrowser: true,
  analyticsHosts: analyticsHosts("https://us.i.posthog.com"),
};

export interface EgressAllowlist {
  /** Hosts the forward proxy must let our services reach. */
  proxyHosts: string[];
  /** Hosts our services must reach without the proxy (the NO_PROXY value). */
  noProxy: string[];
}

/**
 * The proxy host list and the NO_PROXY list for a set of rows. Browser rows
 * are left out: a user's browser is not behind our proxy. So is the Studio
 * browser's any-host row, which is a network route and cannot be a NO_PROXY
 * entry without switching the proxy off for everything.
 */
export function egressAllowlist(entries: readonly EgressEntry[]): EgressAllowlist {
  const server = entries.filter((entry) =>
    entry.services.some((service) => service !== "browser"),
  );
  const hosts = (viaProxy: boolean) =>
    server
      .filter((entry) => entry.viaProxy === viaProxy)
      .map((entry) => entry.host);
  return {
    proxyHosts: [...new Set(hosts(true))].sort(),
    noProxy: [
      ...new Set([
        ...hosts(false).filter((host) => host !== ANY_HOST),
        "localhost",
        "127.0.0.1",
      ]),
    ].sort(),
  };
}

const SERVICE_ORDER: EgressService[] = [
  "web",
  "chat-worker",
  "memory-worker",
  "agent-runtime",
  "browser-proxy",
  "browser",
];

const SERVICE_TITLES: Record<EgressService, string> = {
  web: "web",
  "chat-worker": "chat-worker",
  "memory-worker": "memory-worker",
  "agent-runtime": "agent-runtime (AgentCore container)",
  "browser-proxy": "browser-proxy",
  browser: "The user's browser",
};

/** docs/security/EGRESS_INVENTORY.md, generated from the reference settings. */
export function renderEgressInventoryMarkdown(): string {
  const entries = buildEgressInventory(REFERENCE_EGRESS_SETTINGS);
  const lines = [
    "# Egress inventory",
    "",
    "<!-- Generated by `pnpm egress:inventory` from apps/web/lib/egress-inventory.ts. Do not edit by hand. -->",
    "",
    "Every network destination the product reaches, grouped by the service that",
    "connects. This file lists the widest case: every connector, web search, URL",
    "fetch, the Studio browser, email and analytics on, with github.com hosts and",
    "PostHog's US cloud. `<region>` is the deployment's AWS region and `<this app>`",
    "is its own address. \"Enabled when\" names the setting that keeps the row: a",
    "deployment that turns it off no longer makes that connection.",
    "",
    "For one deployment's exact lists, run the command with that deployment's",
    "environment:",
    "",
    "- `pnpm egress:inventory --json` prints its rows.",
    "- `pnpm egress:inventory --allowlist` prints the hosts its forward proxy must",
    "  allow and its `NO_PROXY` list.",
    "",
    "\"Via proxy\" is yes when the request leaves through `HTTPS_PROXY` in a",
    "firewalled deployment. No means a direct connection: an AWS VPC endpoint, the",
    "internal address, or a connection the user's browser makes from their own",
    "network. `*` means any public host.",
    "",
    "Not listed: the PostgreSQL database (a private address, not HTTP), and what",
    "the container platform needs before the app starts (image pull from ECR, KMS,",
    "STS), which the network stack's VPC endpoint list owns.",
  ];
  for (const service of SERVICE_ORDER) {
    const rows = entries.filter((entry) => entry.services.includes(service));
    if (rows.length === 0) continue;
    lines.push(
      "",
      `## ${SERVICE_TITLES[service]}`,
      "",
      "| Host | Purpose | Via proxy | Enabled when |",
      "|---|---|---|---|",
      ...rows.map(
        (entry) =>
          `| \`${entry.host}\` | ${entry.purpose} | ${entry.viaProxy ? "yes" : "no"} | ${entry.enabledWhen} |`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
