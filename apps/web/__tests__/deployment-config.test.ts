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
