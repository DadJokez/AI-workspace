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

/**
 * Sign-in providers this build knows. `pingone` is generic OIDC: any
 * standards-compliant identity provider works, the id is historical.
 */
export const KNOWN_AUTH_PROVIDERS = ["github", "email", "pingone"] as const;
export type AuthProviderId = (typeof KNOWN_AUTH_PROVIDERS)[number];
const DEFAULT_AUTH_PROVIDERS = "github,email";

/** Subject prefix of every user signed in through OIDC (`users.ping_subject`). */
export const OIDC_SUBJECT_PREFIX = "pingone:";

const DEFAULT_OIDC_SCOPES = "openid profile email";
const DEFAULT_OIDC_GROUPS_CLAIM = "groups";
const DEFAULT_OIDC_DISPLAY_NAME = "Single sign-on";
/** Longest claim name or group name accepted, in settings and in tokens. */
const OIDC_NAME_MAX_CHARS = 256;
const OIDC_DISPLAY_NAME_MAX_CHARS = 64;

const DEFAULT_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const DEFAULT_SESSION_UPDATE_AGE_SECONDS = 60 * 60;
/** Shorter than this and a user is signed out in the middle of a task. */
const SESSION_MIN_AGE_SECONDS = 5 * 60;
/** next-auth's own default; nothing longer is accepted. */
const SESSION_MAX_AGE_LIMIT_SECONDS = 30 * 24 * 60 * 60;

/** OIDC sign-in settings. The client secret is deliberately not held here. */
export type OidcConfig = {
  /** Issuer URL without a trailing slash. */
  issuer: string;
  clientId: string;
  scopes: string;
  /** Claim that lists the user's groups. */
  groupsClaim: string;
  /** Null: OIDC sign-ins never change a role. */
  adminGroup: string | null;
  /** Null: any user the identity provider authenticates may sign in. */
  requiredGroup: string | null;
  adoptEmailUsers: boolean;
  /** Label of the sign-in button. */
  displayName: string;
};

export type AuthConfig = {
  providers: AuthProviderId[];
  /** Null unless `pingone` is enabled and completely configured. */
  oidc: OidcConfig | null;
  magicLink: {
    /** Lower-cased domains; null means any address may ask for a link. */
    allowedDomains: string[] | null;
    /** First instant at which magic links no longer work; null means never. */
    sunsetAt: Date | null;
  };
  session: { maxAgeSeconds: number; updateAgeSeconds: number };
};

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
  auth: AuthConfig;
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
    auth: readAuthConfig(env, production, problems),
    problems,
  };
}

/**
 * The AUTH_PROVIDERS allowlist (comma-separated). Unset or blank means the
 * default "github,email". Unknown ids are dropped, and an allowlist naming
 * only unknown ids is empty: a typo disables sign-in visibly and never falls
 * back to a provider the deployment did not ask for.
 */
function splitAuthProviders(raw: string | undefined): {
  providers: AuthProviderId[];
  unknown: string[];
} {
  const requested = (raw?.trim() ? raw : DEFAULT_AUTH_PROVIDERS)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const known: readonly string[] = KNOWN_AUTH_PROVIDERS;
  return {
    providers: KNOWN_AUTH_PROVIDERS.filter((id) => requested.includes(id)),
    unknown: requested.filter((entry) => !known.includes(entry)),
  };
}

/** `splitAuthProviders`, with a warning naming any id it dropped. */
export function parseAuthProviders(raw: string | undefined): AuthProviderId[] {
  const { providers, unknown } = splitAuthProviders(raw);
  if (unknown.length > 0) {
    console.warn(
      `AUTH_PROVIDERS contains unknown provider(s) ignored: ${unknown.join(", ")}`,
    );
  }
  return providers;
}

/**
 * Sign-in settings. A restriction that cannot be read is reported and the
 * stricter reading stays in force, so a typo never widens who may sign in or
 * who is an admin.
 */
function readAuthConfig(
  env: Env,
  production: boolean,
  problems: string[],
): AuthConfig {
  const { providers } = splitAuthProviders(env.AUTH_PROVIDERS);
  return {
    providers,
    // OIDC_* values are read only when the provider is on, so they can be
    // staged in a deployment before AUTH_PROVIDERS names it.
    oidc: providers.includes("pingone")
      ? readOidcConfig(env, production, problems)
      : null,
    magicLink: readMagicLinkConfig(env, problems),
    session: readSessionConfig(env, problems),
  };
}

function readOidcConfig(
  env: Env,
  production: boolean,
  problems: string[],
): OidcConfig | null {
  const before = problems.length;
  const required = "when pingone is in AUTH_PROVIDERS";

  let issuer: string | null = null;
  const rawIssuer = env.OIDC_ISSUER?.trim();
  if (!rawIssuer) {
    problems.push(`OIDC_ISSUER is required ${required}`);
  } else {
    issuer = parseIssuerUrl(rawIssuer, production);
    if (!issuer) {
      problems.push(
        "OIDC_ISSUER must be an absolute https URL without credentials, query or fragment",
      );
    }
  }

  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!clientId) problems.push(`OIDC_CLIENT_ID is required ${required}`);
  // Presence only: the value is read where the provider is built and nowhere
  // else, so it cannot ride along in anything that prints this object.
  if (!env.OIDC_CLIENT_SECRET?.trim()) {
    problems.push(`OIDC_CLIENT_SECRET is required ${required}`);
  }

  const scopes = (env.OIDC_SCOPES?.trim() || DEFAULT_OIDC_SCOPES)
    .split(/\s+/)
    .filter(Boolean);
  if (
    !scopes.includes("openid") ||
    scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))
  ) {
    problems.push(
      "OIDC_SCOPES must be space-separated scope names that include openid",
    );
  }

  const groupsClaim = env.OIDC_GROUPS_CLAIM?.trim() || DEFAULT_OIDC_GROUPS_CLAIM;
  if (
    groupsClaim.length > OIDC_NAME_MAX_CHARS ||
    !/^[\x21-\x7e]+$/.test(groupsClaim)
  ) {
    problems.push("OIDC_GROUPS_CLAIM must be a claim name without spaces");
  }
  const adminGroup = env.OIDC_ADMIN_GROUP?.trim() || null;
  if (adminGroup && !isOidcGroupName(adminGroup)) {
    problems.push("OIDC_ADMIN_GROUP must be one group name");
  }
  const requiredGroup = env.OIDC_REQUIRED_GROUP?.trim() || null;
  if (requiredGroup && !isOidcGroupName(requiredGroup)) {
    problems.push("OIDC_REQUIRED_GROUP must be one group name");
  }

  const rawAdopt = env.OIDC_ADOPT_EMAIL_USERS?.trim();
  if (rawAdopt && rawAdopt !== "0" && rawAdopt !== "1") {
    problems.push("OIDC_ADOPT_EMAIL_USERS must be 0 or 1");
  }

  const displayName =
    env.OIDC_DISPLAY_NAME?.trim() || DEFAULT_OIDC_DISPLAY_NAME;
  if (
    displayName.length > OIDC_DISPLAY_NAME_MAX_CHARS ||
    CONTROL_CHARACTER.test(displayName)
  ) {
    problems.push(
      `OIDC_DISPLAY_NAME must be at most ${OIDC_DISPLAY_NAME_MAX_CHARS} characters`,
    );
  }

  // Any problem leaves the provider unregistered: it is never built from a
  // half-read configuration.
  if (problems.length > before || !issuer || !clientId) return null;
  return {
    issuer,
    clientId,
    scopes: scopes.join(" "),
    groupsClaim,
    adminGroup,
    requiredGroup,
    // Only an explicit 1 turns adoption on.
    adoptEmailUsers: rawAdopt === "1",
    displayName,
  };
}

/** Plain http is accepted outside production only, for a local test issuer. */
function parseIssuerUrl(value: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && (production || url.protocol !== "http:")) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  return value.replace(/\/+$/, "");
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * A group name as a setting and as a token claim entry: non-empty, bounded,
 * no control characters. Spaces are fine (directory display names).
 */
export function isOidcGroupName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= OIDC_NAME_MAX_CHARS &&
    !CONTROL_CHARACTER.test(value)
  );
}

const DOMAIN_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function readMagicLinkConfig(
  env: Env,
  problems: string[],
): AuthConfig["magicLink"] {
  // An entry that is not a domain is dropped, never widened: a list with no
  // valid domain left allows nobody.
  let allowedDomains: string[] | null = null;
  const rawDomains = env.MAGIC_LINK_ALLOWED_DOMAINS?.trim();
  if (rawDomains) {
    const entries = rawDomains
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const valid = entries.filter((entry) => DOMAIN_NAME.test(entry));
    if (valid.length !== entries.length || entries.length === 0) {
      problems.push(
        "MAGIC_LINK_ALLOWED_DOMAINS must be a comma-separated list of domain names",
      );
    }
    allowedDomains = [...new Set(valid)];
  }

  let sunsetAt: Date | null = null;
  const rawSunset = env.MAGIC_LINK_SUNSET?.trim();
  if (rawSunset) {
    sunsetAt = parseSunset(rawSunset);
    if (!sunsetAt) {
      problems.push(
        "MAGIC_LINK_SUNSET must be an ISO date (YYYY-MM-DD) or a date-time with a zone",
      );
      // An unreadable sunset reads as already past.
      sunsetAt = new Date(0);
    }
  }
  return { allowedDomains, sunsetAt };
}

/**
 * A bare date is the last day magic links work, so the sunset is the start of
 * the next day in UTC. A date-time must name its zone and is the exact instant.
 */
function parseSunset(value: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const start = new Date(Date.UTC(year, month - 1, day));
    // Date.UTC rolls an impossible date (02-30) into the next month.
    if (start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) {
      return null;
    }
    return new Date(start.getTime() + 24 * 60 * 60 * 1000);
  }
  const dateTime =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!dateTime.test(value)) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Session lifetime. `maxAge` is an idle expiry: the cookie is re-issued while
 * the session is in use, at most once per `updateAge`. An unreadable value is
 * reported and today's default stays in force.
 */
function readSessionConfig(env: Env, problems: string[]): AuthConfig["session"] {
  let maxAgeSeconds = DEFAULT_SESSION_MAX_AGE_SECONDS;
  const rawMaxAge = env.SESSION_MAX_AGE_SECONDS?.trim();
  if (rawMaxAge) {
    const parsed = parsePositiveInteger(rawMaxAge);
    if (
      parsed !== null &&
      parsed >= SESSION_MIN_AGE_SECONDS &&
      parsed <= SESSION_MAX_AGE_LIMIT_SECONDS
    ) {
      maxAgeSeconds = parsed;
    } else {
      problems.push(
        `SESSION_MAX_AGE_SECONDS must be a whole number from ${SESSION_MIN_AGE_SECONDS} to ${SESSION_MAX_AGE_LIMIT_SECONDS}`,
      );
    }
  }

  // The default re-issue interval shrinks with a shorter session, so setting
  // only the lifetime is a complete configuration.
  let updateAgeSeconds = Math.min(
    DEFAULT_SESSION_UPDATE_AGE_SECONDS,
    maxAgeSeconds,
  );
  const rawUpdateAge = env.SESSION_UPDATE_AGE_SECONDS?.trim();
  if (rawUpdateAge) {
    const parsed = parsePositiveInteger(rawUpdateAge);
    if (parsed !== null && parsed <= maxAgeSeconds) {
      updateAgeSeconds = parsed;
    } else {
      problems.push(
        "SESSION_UPDATE_AGE_SECONDS must be a whole number from 1 to the session lifetime",
      );
    }
  }
  return { maxAgeSeconds, updateAgeSeconds };
}

function parsePositiveInteger(value: string): number | null {
  return /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null;
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

/**
 * OIDC sign-in settings, or null when the provider is off or misconfigured.
 * Null with `pingone` in AUTH_PROVIDERS means no OIDC sign-in at all.
 */
export const OIDC: OidcConfig | null = config.auth.oidc;

/**
 * True when the identity provider decides who gets in and who is an admin, so
 * the rule that the first person to sign in becomes an admin is off. Read from
 * the allowlist, not from `OIDC`, so a half-configured provider still switches
 * that bootstrap off.
 */
export const OIDC_ENABLED: boolean = config.auth.providers.includes("pingone");

/** Restrictions on who may ask for a magic link, and until when. */
export const MAGIC_LINK: AuthConfig["magicLink"] = config.auth.magicLink;

/** False once MAGIC_LINK_SUNSET has passed. */
export function magicLinksAvailable(now: Date = new Date()): boolean {
  return (
    MAGIC_LINK.sunsetAt === null ||
    now.getTime() < MAGIC_LINK.sunsetAt.getTime()
  );
}

/** Idle session lifetime, and how often the session cookie is re-issued. */
export const SESSION_MAX_AGE_SECONDS: number =
  config.auth.session.maxAgeSeconds;
export const SESSION_UPDATE_AGE_SECONDS: number =
  config.auth.session.updateAgeSeconds;

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
