import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertDeploymentConfig,
  readDeploymentConfig,
} from "@/lib/deployment-config";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deployment config", () => {
  it("has no fallback origin in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NEXT_PHASE", "");

    await expect(import("@/lib/deployment-config")).rejects.toThrow(
      "NEXTAUTH_URL is required in production",
    );
  });

  it("lets next build load route modules without the runtime environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");

    const config = await import("@/lib/deployment-config");
    expect(config.PUBLIC_BASE_URL).toBe("http://localhost:3000");
    expect(() => config.assertDeploymentConfig()).toThrow(
      "NEXTAUTH_URL is required in production",
    );
  });

  it("uses localhost outside production when NEXTAUTH_URL is unset", async () => {
    vi.stubEnv("NEXTAUTH_URL", "");

    const config = await import("@/lib/deployment-config");
    expect(config.PUBLIC_BASE_URL).toBe("http://localhost:3000");
  });

  it("strips trailing slashes from both base URLs", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example/");
    vi.stubEnv("INTERNAL_BASE_URL", "http://internal.example:8080//");

    const config = await import("@/lib/deployment-config");
    expect(config.PUBLIC_BASE_URL).toBe("https://comparative.example");
    expect(config.INTERNAL_BASE_URL).toBe("http://internal.example:8080");
  });

  it("calls back over the internal address only when one is configured", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv("INTERNAL_BASE_URL", "");
    const withoutInternal = await import("@/lib/deployment-config");
    expect(withoutInternal.INTERNAL_BASE_URL).toBeNull();
    expect(withoutInternal.serverCallbackBaseUrl()).toBe(
      "https://comparative.example",
    );

    vi.resetModules();
    vi.stubEnv("INTERNAL_BASE_URL", "http://internal.example:8080");
    const withInternal = await import("@/lib/deployment-config");
    expect(withInternal.serverCallbackBaseUrl()).toBe(
      "http://internal.example:8080",
    );
    expect(withInternal.PUBLIC_BASE_URL).toBe("https://comparative.example");
  });

  it("allows the public host and the configured internal host only", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv("INTERNAL_BASE_URL", "http://internal.example:8080");

    const { isAllowedAppHost } = await import("@/lib/deployment-config");
    expect(isAllowedAppHost("comparative.example")).toBe(true);
    expect(isAllowedAppHost("COMPARATIVE.example")).toBe(true);
    expect(isAllowedAppHost("internal.example:8080")).toBe(true);
    expect(isAllowedAppHost("internal.example")).toBe(false);
    expect(isAllowedAppHost("evil.example")).toBe(false);
    expect(isAllowedAppHost("")).toBe(false);
  });

  it("resolves stored app-relative URLs against the public origin", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv("INTERNAL_BASE_URL", "http://internal.example:8080");

    const { resolveAppRelativeUrl } = await import("@/lib/deployment-config");
    expect(resolveAppRelativeUrl("/api/mcp/google")).toBe(
      "https://comparative.example/api/mcp/google",
    );
    expect(resolveAppRelativeUrl("https://mcp.example/mcp")).toBe(
      "https://mcp.example/mcp",
    );
  });

  it("refuses the internal host when no internal address is configured", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv("INTERNAL_BASE_URL", "");

    const { isAllowedAppHost } = await import("@/lib/deployment-config");
    expect(isAllowedAppHost("internal.example:8080")).toBe(false);
  });

  it("treats a malformed internal address as absent and reports it", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv("INTERNAL_BASE_URL", "internal.example:8080");

    const config = await import("@/lib/deployment-config");
    expect(config.INTERNAL_BASE_URL).toBeNull();
    expect(config.isAllowedAppHost("internal.example:8080")).toBe(false);
    expect(() => config.assertDeploymentConfig()).toThrow(
      "INTERNAL_BASE_URL must be an absolute http(s) URL",
    );
  });

  it("rejects non-http base URLs", () => {
    expect(
      readDeploymentConfig({ NEXTAUTH_URL: "ftp://comparative.example" })
        .problems,
    ).toEqual(["NEXTAUTH_URL must be an absolute http(s) URL"]);
  });

  it("receives GitHub events by webhook unless told to poll", async () => {
    expect(readDeploymentConfig({}).githubEventIngestMode).toBe("webhook");
    expect(
      readDeploymentConfig({ GITHUB_EVENT_INGEST_MODE: "  " })
        .githubEventIngestMode,
    ).toBe("webhook");
    expect(
      readDeploymentConfig({ GITHUB_EVENT_INGEST_MODE: "webhook" }).problems,
    ).toEqual([]);

    const poll = readDeploymentConfig({ GITHUB_EVENT_INGEST_MODE: " Poll " });
    expect(poll.githubEventIngestMode).toBe("poll");
    expect(poll.problems).toEqual([]);

    vi.stubEnv("GITHUB_EVENT_INGEST_MODE", "poll");
    const config = await import("@/lib/deployment-config");
    expect(config.GITHUB_EVENT_INGEST_MODE).toBe("poll");
  });

  it("reports an unknown ingest mode and stays on webhook", () => {
    const config = readDeploymentConfig({ GITHUB_EVENT_INGEST_MODE: "pull" });
    expect(config.githubEventIngestMode).toBe("webhook");
    expect(config.problems).toEqual([
      "GITHUB_EVENT_INGEST_MODE must be webhook or poll",
    ]);
    expect(() =>
      assertDeploymentConfig({ GITHUB_EVENT_INGEST_MODE: "pull" }),
    ).toThrow("GITHUB_EVENT_INGEST_MODE must be webhook or poll");
  });

  it("offers every connector when the list is unset or blank", () => {
    const all = ["github", "notion", "google", "salesforce"];
    expect(readDeploymentConfig({}).enabledConnectorProviders).toEqual(all);
    expect(
      readDeploymentConfig({ ENABLED_CONNECTOR_PROVIDERS: "  " })
        .enabledConnectorProviders,
    ).toEqual(all);
  });

  it("offers exactly the listed connectors", () => {
    const config = readDeploymentConfig({
      ENABLED_CONNECTOR_PROVIDERS: " Salesforce, github ,",
    });
    expect(config.enabledConnectorProviders).toEqual(["github", "salesforce"]);
    expect(config.problems).toEqual([]);
  });

  it("reports an unknown connector name and does not offer it", () => {
    const config = readDeploymentConfig({
      ENABLED_CONNECTOR_PROVIDERS: "github,microsoft",
    });
    expect(config.enabledConnectorProviders).toEqual(["github"]);
    expect(config.problems).toEqual([
      "ENABLED_CONNECTOR_PROVIDERS names unknown providers: microsoft",
    ]);
  });

  it("keeps URL fetch unless it is explicitly turned off", () => {
    expect(readDeploymentConfig({}).webFetchEnabled).toBe(true);
    expect(readDeploymentConfig({ WEB_FETCH_ENABLED: "1" }).webFetchEnabled).toBe(
      true,
    );
    expect(readDeploymentConfig({ WEB_FETCH_ENABLED: "0" }).webFetchEnabled).toBe(
      false,
    );
    const typo = readDeploymentConfig({ WEB_FETCH_ENABLED: "false" });
    expect(typo.webFetchEnabled).toBe(true);
    expect(typo.problems).toEqual(["WEB_FETCH_ENABLED must be 0 or 1"]);
  });

  it("has analytics off by default and on only with a token and host", () => {
    expect(readDeploymentConfig({}).analytics).toBeNull();
    expect(
      readDeploymentConfig({
        POSTHOG_PROJECT_TOKEN: "phc_test",
        POSTHOG_HOST: "https://us.i.posthog.com",
      }).analytics,
    ).toBeNull();
    expect(
      readDeploymentConfig({
        ANALYTICS_PROVIDER: "posthog",
        POSTHOG_PROJECT_TOKEN: "phc_test",
        POSTHOG_HOST: "https://us.i.posthog.com/",
      }).analytics,
    ).toEqual({
      provider: "posthog",
      token: "phc_test",
      host: "https://us.i.posthog.com",
    });
  });

  it("reports incomplete or unknown analytics settings", () => {
    expect(
      readDeploymentConfig({ ANALYTICS_PROVIDER: "posthog" }).problems,
    ).toEqual([
      "POSTHOG_PROJECT_TOKEN is required when ANALYTICS_PROVIDER=posthog",
      "POSTHOG_HOST must be an absolute http(s) URL when ANALYTICS_PROVIDER=posthog",
    ]);
    expect(
      readDeploymentConfig({ ANALYTICS_PROVIDER: "mixpanel" }).problems,
    ).toEqual(["ANALYTICS_PROVIDER must be none or posthog"]);
  });

  it("answers 404 for a connector that is turned off", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv("ENABLED_CONNECTOR_PROVIDERS", "github,salesforce");

    const config = await import("@/lib/deployment-config");
    expect(config.disabledConnectorResponse("github")).toBeNull();
    expect(config.disabledConnectorResponse("google")?.status).toBe(404);
    expect(config.isConnectorProviderEnabled("notion")).toBe(false);
  });

  it("names every problem in one error", () => {
    expect(() =>
      assertDeploymentConfig({
        NODE_ENV: "production",
        INTERNAL_BASE_URL: "not a url",
        BEDROCK_CLIENT: "real",
      }),
    ).toThrow(
      "Invalid deployment configuration: NEXTAUTH_URL is required in production; INTERNAL_BASE_URL must be an absolute http(s) URL; AWS_REGION is required when BEDROCK_CLIENT=real",
    );
  });

  it("accepts a complete production configuration", () => {
    expect(() =>
      assertDeploymentConfig({
        NODE_ENV: "production",
        NEXTAUTH_URL: "https://comparative.example",
        BEDROCK_CLIENT: "real",
        AWS_REGION: "us-east-1",
      }),
    ).not.toThrow();
  });
});

describe("sign-in settings", () => {
  const SECRET = "oidc-client-secret-value";
  const oidcEnv = {
    AUTH_PROVIDERS: "pingone",
    OIDC_ISSUER: "https://sso.example/as",
    OIDC_CLIENT_ID: "comparative",
    OIDC_CLIENT_SECRET: SECRET,
  };
  const auth = (env: Record<string, string | undefined>) =>
    readDeploymentConfig(env).auth;
  const problems = (env: Record<string, string | undefined>) =>
    readDeploymentConfig(env).problems;

  it("reproduces today with nothing set", () => {
    expect(readDeploymentConfig({})).toMatchObject({
      auth: {
        providers: ["github", "email"],
        oidc: null,
        magicLink: { allowedDomains: null, sunsetAt: null },
        session: { maxAgeSeconds: 24 * 60 * 60, updateAgeSeconds: 60 * 60 },
      },
      problems: [],
    });
  });

  it("reads a complete OIDC configuration with its defaults", () => {
    expect(auth(oidcEnv).oidc).toEqual({
      issuer: "https://sso.example/as",
      clientId: "comparative",
      scopes: "openid profile email",
      groupsClaim: "groups",
      adminGroup: null,
      requiredGroup: null,
      adoptEmailUsers: false,
      displayName: "Single sign-on",
    });
    expect(problems(oidcEnv)).toEqual([]);
  });

  it("reads every OIDC override", () => {
    expect(
      auth({
        ...oidcEnv,
        OIDC_ISSUER: "https://sso.example/as//",
        OIDC_SCOPES: " openid  email   groups ",
        OIDC_GROUPS_CLAIM: "https://sso.example/claims/groups",
        OIDC_ADMIN_GROUP: "Comparative Admins",
        OIDC_REQUIRED_GROUP: "comparative-users",
        OIDC_ADOPT_EMAIL_USERS: "1",
        OIDC_DISPLAY_NAME: "Example SSO",
      }).oidc,
    ).toEqual({
      issuer: "https://sso.example/as",
      clientId: "comparative",
      scopes: "openid email groups",
      groupsClaim: "https://sso.example/claims/groups",
      adminGroup: "Comparative Admins",
      requiredGroup: "comparative-users",
      adoptEmailUsers: true,
      displayName: "Example SSO",
    });
  });

  it("never carries the client secret, in the settings or in a problem", () => {
    const complete = readDeploymentConfig(oidcEnv);
    const broken = readDeploymentConfig({ ...oidcEnv, OIDC_ISSUER: "nope" });
    expect(JSON.stringify(complete)).not.toContain(SECRET);
    expect(JSON.stringify(broken)).not.toContain(SECRET);
  });

  it("ignores OIDC variables until AUTH_PROVIDERS names pingone", () => {
    const staged = { ...oidcEnv, AUTH_PROVIDERS: undefined, OIDC_ISSUER: "nope" };
    expect(auth(staged).oidc).toBeNull();
    expect(problems(staged)).toEqual([]);
  });

  it("requires issuer, client id and client secret once pingone is on", () => {
    expect(auth({ AUTH_PROVIDERS: "pingone" }).oidc).toBeNull();
    expect(problems({ AUTH_PROVIDERS: "pingone" })).toEqual([
      "OIDC_ISSUER is required when pingone is in AUTH_PROVIDERS",
      "OIDC_CLIENT_ID is required when pingone is in AUTH_PROVIDERS",
      "OIDC_CLIENT_SECRET is required when pingone is in AUTH_PROVIDERS",
    ]);
  });

  it.each([
    "sso.example",
    "ftp://sso.example",
    "https://user:pass@sso.example",
    "https://sso.example/as?tenant=1",
    "https://sso.example/as#frag",
  ])("rejects %s as an issuer", (issuer) => {
    const env = { ...oidcEnv, OIDC_ISSUER: issuer };
    expect(auth(env).oidc).toBeNull();
    expect(problems(env)).toEqual([
      "OIDC_ISSUER must be an absolute https URL without credentials, query or fragment",
    ]);
  });

  it("accepts a plain-http issuer outside production only", () => {
    const env = { ...oidcEnv, OIDC_ISSUER: "http://127.0.0.1:9000" };
    expect(auth(env).oidc?.issuer).toBe("http://127.0.0.1:9000");
    expect(
      auth({
        ...env,
        NODE_ENV: "production",
        NEXTAUTH_URL: "https://comparative.example",
      }).oidc,
    ).toBeNull();
  });

  it.each([
    ["OIDC_SCOPES", "profile email", "OIDC_SCOPES must be space-separated scope names that include openid"],
    ["OIDC_SCOPES", "openid pro\\file", "OIDC_SCOPES must be space-separated scope names that include openid"],
    ["OIDC_GROUPS_CLAIM", "member of", "OIDC_GROUPS_CLAIM must be a claim name without spaces"],
    ["OIDC_GROUPS_CLAIM", "g".repeat(257), "OIDC_GROUPS_CLAIM must be a claim name without spaces"],
    ["OIDC_ADMIN_GROUP", "g".repeat(257), "OIDC_ADMIN_GROUP must be one group name"],
    ["OIDC_REQUIRED_GROUP", "users\nadmins", "OIDC_REQUIRED_GROUP must be one group name"],
    ["OIDC_ADOPT_EMAIL_USERS", "true", "OIDC_ADOPT_EMAIL_USERS must be 0 or 1"],
    ["OIDC_DISPLAY_NAME", "n".repeat(65), "OIDC_DISPLAY_NAME must be at most 64 characters"],
  ])("reports a bad %s and leaves OIDC off", (name, value, problem) => {
    const env = { ...oidcEnv, [name]: value };
    expect(auth(env).oidc).toBeNull();
    expect(problems(env)).toEqual([problem]);
  });

  it("turns adoption on for an explicit 1 only", () => {
    for (const value of [undefined, "", "0"]) {
      expect(
        auth({ ...oidcEnv, OIDC_ADOPT_EMAIL_USERS: value }).oidc?.adoptEmailUsers,
      ).toBe(false);
    }
  });

  it("reads the allowed magic-link domains, lower-cased", () => {
    expect(
      auth({ MAGIC_LINK_ALLOWED_DOMAINS: " Example.com ,corp.example, example.com" })
        .magicLink.allowedDomains,
    ).toEqual(["example.com", "corp.example"]);
    expect(auth({ MAGIC_LINK_ALLOWED_DOMAINS: "  " }).magicLink.allowedDomains).toBeNull();
  });

  it.each(["*.example.com", "@example.com", "example", "https://example.com"])(
    "drops an unreadable allowed domain (%s) and never widens the list",
    (bad) => {
      const env = { MAGIC_LINK_ALLOWED_DOMAINS: `example.com,${bad}` };
      expect(auth(env).magicLink.allowedDomains).toEqual(["example.com"]);
      expect(problems(env)).toEqual([
        "MAGIC_LINK_ALLOWED_DOMAINS must be a comma-separated list of domain names",
      ]);
      // On its own it leaves an empty list: nobody, not everybody.
      expect(
        auth({ MAGIC_LINK_ALLOWED_DOMAINS: bad }).magicLink.allowedDomains,
      ).toEqual([]);
    },
  );

  it("allows nobody when the list is set but names no domain", () => {
    const env = { MAGIC_LINK_ALLOWED_DOMAINS: " , " };
    expect(auth(env).magicLink.allowedDomains).toEqual([]);
    expect(problems(env)).toHaveLength(1);
  });

  it("reads the sunset: a date is its last day in UTC, a date-time is exact", () => {
    expect(auth({ MAGIC_LINK_SUNSET: "2027-03-31" }).magicLink.sunsetAt).toEqual(
      new Date("2027-04-01T00:00:00Z"),
    );
    expect(
      auth({ MAGIC_LINK_SUNSET: "2027-03-31T17:00:00-05:00" }).magicLink.sunsetAt,
    ).toEqual(new Date("2027-03-31T22:00:00Z"));
  });

  it.each(["soon", "2027-02-30", "2027-13-01", "03/31/2027", "2027-03-31T17:00:00", "1790000000"])(
    "reads an unreadable sunset (%s) as already past",
    (value) => {
      const env = { MAGIC_LINK_SUNSET: value };
      expect(auth(env).magicLink.sunsetAt).toEqual(new Date(0));
      expect(problems(env)).toEqual([
        "MAGIC_LINK_SUNSET must be an ISO date (YYYY-MM-DD) or a date-time with a zone",
      ]);
    },
  );

  it("reads session lifetimes within bounds", () => {
    expect(
      auth({ SESSION_MAX_AGE_SECONDS: "28800", SESSION_UPDATE_AGE_SECONDS: "900" })
        .session,
    ).toEqual({ maxAgeSeconds: 28800, updateAgeSeconds: 900 });
    expect(auth({ SESSION_MAX_AGE_SECONDS: "300" }).session.maxAgeSeconds).toBe(300);
    expect(auth({ SESSION_MAX_AGE_SECONDS: "2592000" }).session.maxAgeSeconds).toBe(
      2592000,
    );
  });

  it("shortens the default re-issue interval to fit a shorter session", () => {
    expect(auth({ SESSION_MAX_AGE_SECONDS: "900" }).session).toEqual({
      maxAgeSeconds: 900,
      updateAgeSeconds: 900,
    });
    expect(problems({ SESSION_MAX_AGE_SECONDS: "900" })).toEqual([]);
  });

  it.each(["0", "-60", "299", "2592001", "3600.5", "1e5", "1h", "99999999999999999999"])(
    "rejects SESSION_MAX_AGE_SECONDS=%s and keeps the default",
    (value) => {
      const env = { SESSION_MAX_AGE_SECONDS: value };
      expect(auth(env).session).toEqual({
        maxAgeSeconds: 24 * 60 * 60,
        updateAgeSeconds: 60 * 60,
      });
      expect(problems(env)).toEqual([
        "SESSION_MAX_AGE_SECONDS must be a whole number from 300 to 2592000",
      ]);
    },
  );

  it.each(["0", "-1", "abc", "86401"])(
    "rejects SESSION_UPDATE_AGE_SECONDS=%s and keeps the default",
    (value) => {
      const env = { SESSION_UPDATE_AGE_SECONDS: value };
      expect(auth(env).session.updateAgeSeconds).toBe(60 * 60);
      expect(problems(env)).toEqual([
        "SESSION_UPDATE_AGE_SECONDS must be a whole number from 1 to the session lifetime",
      ]);
    },
  );

  it("fails boot on a bad sign-in setting", () => {
    expect(() =>
      assertDeploymentConfig({ AUTH_PROVIDERS: "pingone", SESSION_MAX_AGE_SECONDS: "never" }),
    ).toThrow(/OIDC_ISSUER is required.*SESSION_MAX_AGE_SECONDS must be/);
  });
});
