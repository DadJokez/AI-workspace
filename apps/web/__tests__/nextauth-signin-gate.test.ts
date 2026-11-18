import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Verifies the `signIn` callback in apps/web/lib/auth/nextauth.ts for BOTH
 * providers.
 *
 * GitHub accept/deny paths:
 *   - first-ever sign-in is allowed (becomes admin via ensureUser later)
 *   - existing GitHub identity (by subject) is allowed
 *   - existing user matched by EMAIL only is refused: a GitHub identity is
 *     never attached to an existing user by address (WP-17)
 *   - pending invitation for the email is allowed
 *   - no existing user, no invite → deny
 *
 * Email (magic-link) paths — the gate runs at link-REQUEST time
 * (`email.verificationRequest === true`, before any mail is sent) and again
 * at link-click callback time (`email` undefined):
 *   - existing user by email → allowed (link sent)
 *   - pending invitation → allowed (link sent)
 *   - stranger → denied (NO link is ever sent)
 *   - empty users table → allowed (first-signer bootstrap, GitHub parity)
 *   - MAGIC_LINK_ALLOWED_DOMAINS and MAGIC_LINK_SUNSET refuse before any
 *     account is looked up
 *
 * With OIDC enabled the first-signer bootstrap is off for both.
 *
 * The drizzle proxy sequences `users` selects (first = by-subject for GitHub,
 * then by-email; email flow only probes by-email) and distinguishes selects
 * against `invitations` so each case is driven independently.
 */

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface ProxyOpts {
  existingUserCount: number;
  /**
   * Result queue for `users` selects that end in `.limit(1)`, in call order.
   * GitHub flow: [bySubject, byEmail?]; email flow: [byEmail].
   */
  usersSelects: boolean[];
  pendingInviteForEmail: boolean;
}

function makeProxy(opts: ProxyOpts): unknown {
  let currentTarget: "users" | "invitations" | "unknown" = "unknown";
  const usersQueue = [...opts.usersSelects];

  function tableName(arg: unknown): typeof currentTarget {
    const s = String(
      // biome-ignore lint/suspicious/noExplicitAny: probe-only
      (arg as any)?.[Symbol.for("drizzle:Name")] ??
        // biome-ignore lint/suspicious/noExplicitAny: probe-only
        (arg as any)?._?.name ??
        "",
    );
    if (s === "users") return "users";
    if (s === "invitations") return "invitations";
    return "unknown";
  }

  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "from") {
          return (table: unknown) => {
            currentTarget = tableName(table);
            return proxy;
          };
        }
        if (prop === "limit") {
          return () => {
            if (currentTarget === "users") {
              const found = usersQueue.shift() ?? false;
              return Promise.resolve(
                found ? [{ id: "existing-user-uuid" }] : [],
              );
            }
            if (currentTarget === "invitations") {
              return Promise.resolve(
                opts.pendingInviteForEmail
                  ? [{ id: "invite-uuid", role: "user" }]
                  : [],
              );
            }
            return Promise.resolve([]);
          };
        }
        if (prop === "then") {
          // `await db.select({count}).from(users)` — resolves directly.
          return (resolve: (v: unknown) => void) =>
            resolve([{ count: opts.existingUserCount }]);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

async function loadSignIn(opts: ProxyOpts) {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return {
      ...actual,
      getDb: () => makeProxy(opts) as never,
    };
  });

  // ensureUser is called from the jwt callback, not signIn; stubbing it keeps
  // tests independent of the real DB write path.
  vi.doMock("@/lib/users", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/users")>("@/lib/users");
    return {
      ...actual,
      findPendingInvitation: async () =>
        opts.pendingInviteForEmail
          ? { id: "invite-uuid", role: "user" as const }
          : null,
    };
  });

  const { authOptions } = await import("@/lib/auth/nextauth");
  const signIn = authOptions.callbacks?.signIn;
  if (!signIn) throw new Error("signIn callback not configured");
  return signIn;
}

async function callSignInGithub(
  opts: ProxyOpts,
  args: {
    provider?: string;
    email?: string | null;
  } = {},
): Promise<boolean | undefined> {
  const signIn = await loadSignIn(opts);

  // `email === null` is "GitHub returned no email"; `undefined` means "not
  // overridden, use the default address". null wins via the explicit check.
  const resolvedEmail = args.email === null
    ? null
    : args.email ?? "test@example.com";

  const result = await signIn({
    user: {
      id: "12345",
      email: resolvedEmail ?? undefined,
      name: "Test User",
      image: null,
    },
    // biome-ignore lint/suspicious/noExplicitAny: NextAuth's Account type is wider than we use
    account: {
      provider: args.provider ?? "github",
      providerAccountId: "12345",
      type: "oauth",
      access_token: "gho_fake",
    } as any,
    profile: {
      email: resolvedEmail,
      name: "Test User",
      // biome-ignore lint/suspicious/noExplicitAny: profile shape is provider-specific
    } as any,
    credentials: undefined,
  });

  return typeof result === "boolean" ? result : undefined;
}

async function callSignInEmail(
  opts: ProxyOpts,
  args: {
    phase: "request" | "callback";
    address?: string;
  },
): Promise<boolean | undefined> {
  const signIn = await loadSignIn(opts);
  const address = args.address ?? "tester@example.com";

  // Mirrors next-auth v4 exactly: signin phase passes the (possibly stub)
  // adapter user + `email: { verificationRequest: true }`; the link-click
  // callback passes the user and account but NO `email` property.
  const result = await signIn({
    user: {
      id: address,
      email: address,
      emailVerified: null,
      // biome-ignore lint/suspicious/noExplicitAny: adapter-user stub shape from core/lib/email/getUserFromEmail
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: NextAuth's Account type is wider than we use
    account: {
      provider: "email",
      providerAccountId: address,
      type: "email",
    } as any,
    ...(args.phase === "request"
      ? { email: { verificationRequest: true } }
      : {}),
    credentials: undefined,
  });

  return typeof result === "boolean" ? result : undefined;
}

describe("nextauth — signIn gate (github)", () => {
  it("allows the first-ever signer (empty users table)", async () => {
    const ok = await callSignInGithub({
      existingUserCount: 0,
      usersSelects: [false, false],
      pendingInviteForEmail: false,
    });
    expect(ok).toBe(true);
  });

  it("allows an existing user (matched by GitHub sub)", async () => {
    const ok = await callSignInGithub({
      existingUserCount: 5,
      usersSelects: [true],
      pendingInviteForEmail: false,
    });
    expect(ok).toBe(true);
  });

  it("refuses a GitHub identity whose address belongs to an existing user (no linking by email), even with an invitation", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    const signIn = await loadSignIn({
      existingUserCount: 5,
      usersSelects: [false, true],
      pendingInviteForEmail: true,
    });
    const result = await signIn({
      user: { id: "12345", email: "test@example.com", name: "Test User" },
      // biome-ignore lint/suspicious/noExplicitAny: NextAuth's Account type is wider than we use
      account: { provider: "github", providerAccountId: "12345", type: "oauth" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: profile shape is provider-specific
      profile: { email: "test@example.com" } as any,
      credentials: undefined,
    });
    // A redirect to the login page with a reason code, not a session.
    expect(result).toBe(
      "https://comparative.example/login?error=AccessDenied&reason=email_in_use",
    );
  });

  it("does not let the first GitHub signer in once OIDC is enabled", async () => {
    vi.stubEnv("AUTH_PROVIDERS", "pingone,github");
    const ok = await callSignInGithub({
      existingUserCount: 0,
      usersSelects: [false, false],
      pendingInviteForEmail: false,
    });
    expect(ok).toBe(false);
  });

  it("allows a sign-in when there's a pending invitation for the email", async () => {
    const ok = await callSignInGithub({
      existingUserCount: 5,
      usersSelects: [false, false],
      pendingInviteForEmail: true,
    });
    expect(ok).toBe(true);
  });

  it("denies a sign-in with no matching user and no invite", async () => {
    const ok = await callSignInGithub({
      existingUserCount: 5,
      usersSelects: [false, false],
      pendingInviteForEmail: false,
    });
    expect(ok).toBe(false);
  });

  it("denies an unknown provider", async () => {
    const ok = await callSignInGithub(
      {
        existingUserCount: 0,
        usersSelects: [false, false],
        pendingInviteForEmail: false,
      },
      { provider: "google" },
    );
    expect(ok).toBe(false);
  });

  it("denies when GitHub returns no email", async () => {
    const ok = await callSignInGithub(
      {
        existingUserCount: 0,
        usersSelects: [false, false],
        pendingInviteForEmail: false,
      },
      { email: null },
    );
    expect(ok).toBe(false);
  });
});

describe("nextauth — signIn gate (email magic link)", () => {
  it("request phase: allows an existing user's email", async () => {
    const ok = await callSignInEmail(
      {
        existingUserCount: 5,
        usersSelects: [true],
        pendingInviteForEmail: false,
      },
      { phase: "request" },
    );
    expect(ok).toBe(true);
  });

  it("request phase: allows an invited email", async () => {
    const ok = await callSignInEmail(
      {
        existingUserCount: 5,
        usersSelects: [false],
        pendingInviteForEmail: true,
      },
      { phase: "request" },
    );
    expect(ok).toBe(true);
  });

  it("request phase: denies a stranger — no link is sent", async () => {
    const ok = await callSignInEmail(
      {
        existingUserCount: 5,
        usersSelects: [false],
        pendingInviteForEmail: false,
      },
      { phase: "request" },
    );
    expect(ok).toBe(false);
  });

  it("request phase: allows the first-ever signer (empty users table)", async () => {
    const ok = await callSignInEmail(
      {
        existingUserCount: 0,
        usersSelects: [false],
        pendingInviteForEmail: false,
      },
      { phase: "request" },
    );
    expect(ok).toBe(true);
  });

  it("callback phase: allows an existing user's email", async () => {
    const ok = await callSignInEmail(
      {
        existingUserCount: 5,
        usersSelects: [true],
        pendingInviteForEmail: false,
      },
      { phase: "callback" },
    );
    expect(ok).toBe(true);
  });

  it("callback phase: denies when the invite was revoked between request and click", async () => {
    const ok = await callSignInEmail(
      {
        existingUserCount: 5,
        usersSelects: [false],
        pendingInviteForEmail: false,
      },
      { phase: "callback" },
    );
    expect(ok).toBe(false);
  });

  it("does not let the first magic-link signer in once OIDC is enabled", async () => {
    vi.stubEnv("AUTH_PROVIDERS", "pingone,email");
    const ok = await callSignInEmail(
      {
        existingUserCount: 0,
        usersSelects: [false],
        pendingInviteForEmail: false,
      },
      { phase: "request" },
    );
    expect(ok).toBe(false);
  });
});

describe("nextauth — magic-link restrictions", () => {
  /**
   * Every account check would say yes: the address is an existing user and
   * holds an invitation. A refusal therefore came from the restriction alone.
   */
  const everyCheckPasses: ProxyOpts = {
    existingUserCount: 5,
    usersSelects: [true],
    pendingInviteForEmail: true,
  };
  const existingUser: ProxyOpts = {
    existingUserCount: 5,
    usersSelects: [true],
    pendingInviteForEmail: false,
  };

  it.each(["request", "callback"] as const)(
    "%s phase: allows an address in an allowed domain, whatever its case",
    async (phase) => {
      vi.stubEnv("MAGIC_LINK_ALLOWED_DOMAINS", "Example.com, corp.example");
      const ok = await callSignInEmail(existingUser, {
        phase,
        address: "Tester@EXAMPLE.com",
      });
      expect(ok).toBe(true);
    },
  );

  it.each([
    "tester@evil-example.com",
    "tester@example.com.evil.example",
    "tester@sub.example.com",
    "tester@notexample.com",
    "tester@example.co",
    "tester@example.com.",
    "tester@example.com@evil.example",
    "tester@evil.example@example.com",
    "example.com",
  ])("refuses %s, existing and invited or not", async (address) => {
    vi.stubEnv("MAGIC_LINK_ALLOWED_DOMAINS", "example.com");
    for (const phase of ["request", "callback"] as const) {
      vi.resetModules();
      // The answer never depends on whether the account exists.
      expect(await callSignInEmail(everyCheckPasses, { phase, address })).toBe(
        false,
      );
    }
  });

  it("refuses everyone when the list holds no readable domain", async () => {
    vi.stubEnv("MAGIC_LINK_ALLOWED_DOMAINS", "*.example.com");
    const ok = await callSignInEmail(everyCheckPasses, {
      phase: "request",
      address: "tester@example.com",
    });
    expect(ok).toBe(false);
  });

  it.each(["request", "callback"] as const)(
    "%s phase: refuses every address after the sunset, existing users included",
    async (phase) => {
      vi.stubEnv("MAGIC_LINK_SUNSET", "2020-01-01");
      expect(await callSignInEmail(everyCheckPasses, { phase })).toBe(false);
    },
  );

  it("refuses once the sunset passes while the server is running", async () => {
    vi.stubEnv("MAGIC_LINK_SUNSET", "2030-03-31");
    vi.useFakeTimers({ now: new Date("2030-03-31T12:00:00Z") });
    try {
      const signInBefore = await callSignInEmail(existingUser, {
        phase: "request",
      });
      expect(signInBefore).toBe(true);

      // Same loaded module, a day later: the link issued above is dead too.
      const { authOptions } = await import("@/lib/auth/nextauth");
      vi.setSystemTime(new Date("2030-04-01T00:00:00Z"));
      const after = await authOptions.callbacks!.signIn!({
        // biome-ignore lint/suspicious/noExplicitAny: adapter-user stub shape
        user: { id: "tester@example.com", email: "tester@example.com" } as any,
        // biome-ignore lint/suspicious/noExplicitAny: NextAuth's Account type is wider than we use
        account: { provider: "email", providerAccountId: "tester@example.com", type: "email" } as any,
        credentials: undefined,
      });
      expect(after).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an unreadable sunset as already past", async () => {
    vi.stubEnv("MAGIC_LINK_SUNSET", "next tuesday");
    expect(await callSignInEmail(everyCheckPasses, { phase: "request" })).toBe(
      false,
    );
  });
});
