import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Verifies the `signIn` callback in apps/web/lib/auth/nextauth.ts. The
 * accept/deny paths it has to get right:
 *   - existing GitHub identity is allowed
 *   - email matches a legacy shim row → adopt + migrate ping_subject
 *   - first-ever sign-in is allowed (becomes admin via ensureUser later)
 *   - pending invitation for the email is allowed
 *   - no existing user, no invite → deny (keeps random GitHub users out)
 *
 * The drizzle proxy distinguishes selects against `users` from selects
 * against `invitations`, and counts users-table selects so the second one
 * (the email-fallback inside the migration transaction) returns its own
 * configured result independent of the first (ghSub) lookup.
 */

afterEach(() => {
  vi.resetModules();
});

interface ProxyOpts {
  existingUserCount: number;
  userExistsByGhSub: boolean;
  /**
   * Result of the second users-select in the signIn callback (the email
   * fallback inside the migration transaction). Defaults to false so existing
   * tests that don't exercise the migration path don't need to set it.
   */
  userExistsByEmail?: boolean;
  pendingInviteForEmail: boolean;
}

function makeProxy(opts: ProxyOpts): unknown {
  let currentTarget: "users" | "invitations" | "unknown" = "unknown";
  let usersLimitCalls = 0;

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
        if (prop === "transaction") {
          // `db.transaction(async (tx) => …)` — invoke the callback with the
          // same proxy as the tx handle. Counters are shared so the in-tx
          // users-select counts as the second users lookup.
          return async (cb: (tx: unknown) => unknown) => cb(proxy);
        }
        if (prop === "limit") {
          return () => {
            if (currentTarget === "users") {
              usersLimitCalls += 1;
              // 1st users-select = lookup by ghSub; 2nd = email fallback.
              const exists =
                usersLimitCalls === 1
                  ? opts.userExistsByGhSub
                  : (opts.userExistsByEmail ?? false);
              return Promise.resolve(
                exists ? [{ id: "existing-user-uuid" }] : [],
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

async function callSignIn(
  opts: ProxyOpts,
  args: {
    provider?: string;
    email?: string | null;
  } = {},
): Promise<boolean | undefined> {
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

describe("nextauth — signIn gate", () => {
  it("allows the first-ever signer (empty users table)", async () => {
    const ok = await callSignIn({
      existingUserCount: 0,
      userExistsByGhSub: false,
      pendingInviteForEmail: false,
    });
    expect(ok).toBe(true);
  });

  it("allows an existing user (matched by GitHub sub)", async () => {
    const ok = await callSignIn({
      existingUserCount: 5,
      userExistsByGhSub: true,
      pendingInviteForEmail: false,
    });
    expect(ok).toBe(true);
  });

  it("adopts a legacy shim row when GitHub sub misses but email matches", async () => {
    const ok = await callSignIn({
      existingUserCount: 1,
      userExistsByGhSub: false,
      userExistsByEmail: true,
      pendingInviteForEmail: false,
    });
    expect(ok).toBe(true);
  });

  it("allows a sign-in when there's a pending invitation for the email", async () => {
    const ok = await callSignIn({
      existingUserCount: 5,
      userExistsByGhSub: false,
      pendingInviteForEmail: true,
    });
    expect(ok).toBe(true);
  });

  it("denies a sign-in with no matching user and no invite", async () => {
    const ok = await callSignIn({
      existingUserCount: 5,
      userExistsByGhSub: false,
      pendingInviteForEmail: false,
    });
    expect(ok).toBe(false);
  });

  it("denies a non-github provider", async () => {
    const ok = await callSignIn(
      {
        existingUserCount: 0,
        userExistsByGhSub: false,
        pendingInviteForEmail: false,
      },
      { provider: "google" },
    );
    expect(ok).toBe(false);
  });

  it("denies when GitHub returns no email", async () => {
    const ok = await callSignIn(
      {
        existingUserCount: 0,
        userExistsByGhSub: false,
        pendingInviteForEmail: false,
      },
      { email: null },
    );
    expect(ok).toBe(false);
  });
});
