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
