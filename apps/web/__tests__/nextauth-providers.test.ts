import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * AUTH_PROVIDERS allowlist → providers array wiring in
 * apps/web/lib/auth/nextauth.ts, plus the config invariants the magic-link
 * design depends on (JWT sessions, adapter present, 15-minute link expiry,
 * custom SES send seam instead of nodemailer).
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function loadAuthModule(authProviders?: string) {
  if (authProviders !== undefined) {
    vi.stubEnv("AUTH_PROVIDERS", authProviders);
  }
  return import("@/lib/auth/nextauth");
}

describe("parseAuthProviders", () => {
  it("defaults to github,email when unset or blank", async () => {
    const { parseAuthProviders } = await loadAuthModule();
    expect(parseAuthProviders(undefined)).toEqual(["github", "email"]);
    expect(parseAuthProviders("")).toEqual(["github", "email"]);
    expect(parseAuthProviders("   ")).toEqual(["github", "email"]);
  });

  it("filters to a single provider", async () => {
    const { parseAuthProviders } = await loadAuthModule();
    expect(parseAuthProviders("email")).toEqual(["email"]);
    expect(parseAuthProviders("github")).toEqual(["github"]);
  });

  it("normalizes case and whitespace", async () => {
    const { parseAuthProviders } = await loadAuthModule();
    expect(parseAuthProviders(" Email , GITHUB ")).toEqual([
      "github",
      "email",
    ]);
  });

  it("ignores unknown ids (pingone can be staged early) with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { parseAuthProviders } = await loadAuthModule();
    expect(parseAuthProviders("pingone,email")).toEqual(["email"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("pingone"),
    );
  });

  it("fails closed when only unknown ids are listed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { parseAuthProviders } = await loadAuthModule();
    expect(parseAuthProviders("pingone")).toEqual([]);
  });
});

describe("authOptions provider wiring", () => {
  it("builds github + email by default, email provider with 15-minute links", async () => {
    const { authOptions } = await loadAuthModule();
    const ids = authOptions.providers.map((p) => p.id);
    expect(ids).toEqual(["github", "email"]);

    const email = authOptions.providers.find((p) => p.id === "email") as {
      type: string;
      maxAge?: number;
      sendVerificationRequest?: unknown;
    };
    expect(email.type).toBe("email");
    expect(email.maxAge).toBe(15 * 60);
    expect(typeof email.sendVerificationRequest).toBe("function");
  });

  it("honors an email-only allowlist", async () => {
    const { authOptions } = await loadAuthModule("email");
    expect(authOptions.providers.map((p) => p.id)).toEqual(["email"]);
  });

  it("honors a github-only allowlist", async () => {
    const { authOptions } = await loadAuthModule("github");
    expect(authOptions.providers.map((p) => p.id)).toEqual(["github"]);
  });

  it("keeps sessions on the JWT strategy with the adapter attached", async () => {
    const { authOptions } = await loadAuthModule();
    expect(authOptions.session?.strategy).toBe("jwt");
    expect(authOptions.adapter).toBeDefined();
    // The email flow's required adapter surface (next-auth asserts these).
    expect(authOptions.adapter?.createVerificationToken).toBeTypeOf("function");
    expect(authOptions.adapter?.useVerificationToken).toBeTypeOf("function");
    expect(authOptions.adapter?.getUserByEmail).toBeTypeOf("function");
  });

  it("exposes the same list to the login page via enabledAuthProviders", async () => {
    const { enabledAuthProviders } = await loadAuthModule("email");
    expect(enabledAuthProviders()).toEqual(["email"]);
  });
});
