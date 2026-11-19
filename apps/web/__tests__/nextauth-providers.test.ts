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

  it("ignores unknown ids with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { parseAuthProviders } = await loadAuthModule();
    expect(parseAuthProviders("okta,email")).toEqual(["email"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("okta"),
    );
  });

  it("fails closed when only unknown ids are listed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { parseAuthProviders } = await loadAuthModule();
    expect(parseAuthProviders("okta")).toEqual([]);
  });

  it("knows pingone, which is only on when the allowlist names it", async () => {
    const { parseAuthProviders } = await loadAuthModule();
    expect(parseAuthProviders("pingone")).toEqual(["pingone"]);
    expect(parseAuthProviders("PingOne, email")).toEqual(["email", "pingone"]);
    expect(parseAuthProviders(undefined)).not.toContain("pingone");
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

  it("is unchanged by default: with every WP-17 variable unset, providers and session are today's", async () => {
    for (const name of [
      "AUTH_PROVIDERS",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "OIDC_SCOPES",
      "OIDC_GROUPS_CLAIM",
      "OIDC_ADMIN_GROUP",
      "OIDC_REQUIRED_GROUP",
      "OIDC_ADOPT_EMAIL_USERS",
      "OIDC_DISPLAY_NAME",
      "MAGIC_LINK_ALLOWED_DOMAINS",
      "MAGIC_LINK_SUNSET",
      "SESSION_MAX_AGE_SECONDS",
      "SESSION_UPDATE_AGE_SECONDS",
    ]) {
      vi.stubEnv(name, undefined);
    }
    const { authOptions, enabledAuthProviders, magicLinkDomainAllowed } =
      await import("@/lib/auth/nextauth");
    const { assertDeploymentConfig, OIDC, OIDC_ENABLED } = await import(
      "@/lib/deployment-config"
    );

    expect(authOptions.providers.map((p) => p.id)).toEqual(["github", "email"]);
    expect(enabledAuthProviders()).toEqual(["github", "email"]);
    expect(authOptions.session).toEqual({
      strategy: "jwt",
      maxAge: 24 * 60 * 60,
      updateAge: 60 * 60,
    });
    expect(OIDC).toBeNull();
    expect(OIDC_ENABLED).toBe(false);
    expect(magicLinkDomainAllowed("anyone@anywhere.example")).toBe(true);
    expect(() => assertDeploymentConfig()).not.toThrow();
  });
});

describe("OIDC provider wiring", () => {
  const CLIENT_SECRET = "oidc-client-secret-value";

  function stubOidc(overrides: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      AUTH_PROVIDERS: "pingone,email",
      OIDC_ISSUER: "https://sso.example/as/",
      OIDC_CLIENT_ID: "comparative",
      OIDC_CLIENT_SECRET: CLIENT_SECRET,
      ...overrides,
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  }

  it("registers a discovery-based OIDC provider with PKCE, state and nonce", async () => {
    stubOidc();
    const { authOptions, enabledAuthProviders } = await import(
      "@/lib/auth/nextauth"
    );

    expect(authOptions.providers.map((p) => p.id)).toEqual(["email", "pingone"]);
    expect(enabledAuthProviders()).toEqual(["email", "pingone"]);
    const provider = authOptions.providers.find((p) => p.id === "pingone");
    expect(provider).toMatchObject({
      type: "oauth",
      name: "Single sign-on",
      wellKnown: "https://sso.example/as/.well-known/openid-configuration",
      idToken: true,
      checks: ["pkce", "state", "nonce"],
      authorization: { params: { scope: "openid profile email" } },
      clientId: "comparative",
      clientSecret: CLIENT_SECRET,
    });
    // Linking a sign-in to an existing user by address stays off.
    expect(provider).not.toHaveProperty("allowDangerousEmailAccountLinking");
  });

  it("takes scopes and the button label from the environment", async () => {
    stubOidc({
      OIDC_SCOPES: "openid email groups",
      OIDC_DISPLAY_NAME: "Example SSO",
    });
    const { authOptions } = await import("@/lib/auth/nextauth");
    expect(authOptions.providers.find((p) => p.id === "pingone")).toMatchObject({
      name: "Example SSO",
      authorization: { params: { scope: "openid email groups" } },
    });
  });

  it.each(["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"])(
    "registers no OIDC provider while %s is missing, and reports it at boot",
    async (missing) => {
      stubOidc({ [missing]: undefined });
      const { authOptions, enabledAuthProviders } = await import(
        "@/lib/auth/nextauth"
      );
      const { assertDeploymentConfig } = await import("@/lib/deployment-config");

      expect(authOptions.providers.map((p) => p.id)).toEqual(["email"]);
      expect(enabledAuthProviders()).toEqual(["email"]);
      expect(() => assertDeploymentConfig()).toThrow(
        `${missing} is required when pingone is in AUTH_PROVIDERS`,
      );
    },
  );

  it("maps claims to a namespaced subject and never throws on claims that make no identity", async () => {
    stubOidc();
    const { authOptions } = await import("@/lib/auth/nextauth");
    const provider = authOptions.providers.find((p) => p.id === "pingone") as {
      profile: (claims: unknown, tokens: unknown) => unknown;
    };

    expect(
      provider.profile(
        { sub: "abc-123", email: "Person@Example.com", name: "A Person" },
        {},
      ),
    ).toEqual({
      id: "pingone:abc-123",
      email: "person@example.com",
      name: "A Person",
    });
    // next-auth logs the whole claim set when profile() throws.
    for (const claims of [null, {}, { sub: 7 }, { sub: "abc" }]) {
      expect(provider.profile(claims, {})).toEqual({
        id: "pingone:",
        email: null,
        name: null,
      });
    }
  });

  it("no longer lets GitHub attach to an existing user by address", async () => {
    const { authOptions } = await loadAuthModule("github");
    const github = authOptions.providers.find((p) => p.id === "github") as {
      allowDangerousEmailAccountLinking?: boolean;
      options?: { allowDangerousEmailAccountLinking?: boolean };
    };
    expect(github.allowDangerousEmailAccountLinking).toBeUndefined();
    expect(github.options?.allowDangerousEmailAccountLinking).toBeUndefined();
  });
});

describe("magic-link sunset", () => {
  it("registers no email provider and offers no form once the sunset has passed", async () => {
    vi.stubEnv("MAGIC_LINK_SUNSET", "2020-01-01");
    const { authOptions, enabledAuthProviders } = await import(
      "@/lib/auth/nextauth"
    );
    expect(authOptions.providers.map((p) => p.id)).toEqual(["github"]);
    expect(enabledAuthProviders()).toEqual(["github"]);
  });

  it("keeps the provider until the sunset, then stops offering it without a restart", async () => {
    vi.stubEnv("MAGIC_LINK_SUNSET", "2999-06-30");
    const { authOptions, enabledAuthProviders } = await import(
      "@/lib/auth/nextauth"
    );
    expect(authOptions.providers.map((p) => p.id)).toEqual(["github", "email"]);
    // The date is the last day links work, in UTC.
    expect(enabledAuthProviders(new Date("2999-06-30T23:59:59Z"))).toEqual([
      "github",
      "email",
    ]);
    expect(enabledAuthProviders(new Date("2999-07-01T00:00:00Z"))).toEqual([
      "github",
    ]);
  });
});
