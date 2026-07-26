import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Authentication events reach the audit ledger, and the session has an
 * explicit lifetime.
 *
 * The ledger recorded ~60 application action types and zero authentication
 * events before this; an access review had no way to answer "who signed in,
 * who was refused". These tests drive next-auth's real `events` and `signIn`
 * callback from `authOptions` and assert the rows that come out — including
 * that no token material rides along, even though the `account` object handed
 * to the callbacks carries OAuth tokens.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS_TOKEN = "gho_super_secret_access_token";
const ID_TOKEN = "eyJ_super_secret_id_token";
const SESSION_JWT = "super-secret-session-jwt";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("next/headers");
});

interface DbOpts {
  /** Result queue for `users` selects ending in `.limit(1)`, in call order. */
  usersSelects: boolean[];
  existingUserCount: number;
  pendingInviteForEmail: boolean;
}

/**
 * Same drizzle proxy shape as nextauth-signin-gate.test.ts, plus an `insert`
 * that captures the audit rows.
 */
function makeDb(opts: DbOpts, inserted: Record<string, unknown>[]): unknown {
  let currentTarget: "users" | "invitations" | "unknown" = "unknown";
  const usersQueue = [...opts.usersSelects];

  function tableName(arg: unknown): typeof currentTarget {
    const name = String(
      // biome-ignore lint/suspicious/noExplicitAny: probe-only
      (arg as any)?.[Symbol.for("drizzle:Name")] ?? "",
    );
    if (name === "users") return "users";
    if (name === "invitations") return "invitations";
    return "unknown";
  }

  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "insert") {
          return () => ({
            values: async (row: Record<string, unknown>) => {
              inserted.push(row);
            },
          });
        }
        if (prop === "from") {
          return (table: unknown) => {
            currentTarget = tableName(table);
            return proxy;
          };
        }
        if (prop === "limit") {
          return () => {
            if (currentTarget === "users") {
              return Promise.resolve(
                usersQueue.shift() ? [{ id: ACTOR_ID }] : [],
              );
            }
            if (currentTarget === "invitations") {
              return Promise.resolve(
                opts.pendingInviteForEmail ? [{ id: "invite-uuid" }] : [],
              );
            }
            return Promise.resolve([]);
          };
        }
        if (prop === "then") {
          return (resolve: (v: unknown) => void) =>
            resolve([{ count: opts.existingUserCount }]);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

async function loadAuthOptions(opts: DbOpts, inserted: Record<string, unknown>[]) {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return { ...actual, getDb: () => makeDb(opts, inserted) as never };
  });
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
  // next-auth hands the callbacks no request; auth-audit reaches for the
  // App Router request scope instead.
  vi.doMock("next/headers", () => ({
    headers: async () =>
      new Headers({
        "x-forwarded-for": "198.51.100.9, 203.0.113.7",
        "user-agent": "Mozilla/5.0 (Macintosh)",
        cookie: `next-auth.session-token=${SESSION_JWT}`,
      }),
  }));

  const { authOptions } = await import("@/lib/auth/nextauth");
  return authOptions;
}

const allowAll: DbOpts = {
  usersSelects: [true],
  existingUserCount: 5,
  pendingInviteForEmail: true,
};

// biome-ignore lint/suspicious/noExplicitAny: NextAuth's Account type is wider than we use
const githubAccount = {
  provider: "github",
  providerAccountId: "12345",
  type: "oauth",
  access_token: ACCESS_TOKEN,
  id_token: ID_TOKEN,
} as any;

describe("nextauth — auth event auditing", () => {
  it("records a successful sign-in with ip and user-agent", async () => {
    const inserted: Record<string, unknown>[] = [];
    const authOptions = await loadAuthOptions(allowAll, inserted);

    await authOptions.events?.signIn?.({
      user: { id: ACTOR_ID, email: "tester@example.com", name: "Tester" },
      account: githubAccount,
      isNewUser: false,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actorUserId: ACTOR_ID,
      actionType: "auth_sign_in",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "auth",
      metadata: {
        schema: "auth-event.v1",
        authProvider: "github",
        isNewUser: false,
        // Rightmost x-forwarded-for hop: the one the ALB appended.
        ip: "203.0.113.7",
        userAgent: "Mozilla/5.0 (Macintosh)",
      },
    });
  });

  it("never writes token material, even though the account carries it", async () => {
    const inserted: Record<string, unknown>[] = [];
    const authOptions = await loadAuthOptions(allowAll, inserted);

    await authOptions.events?.signIn?.({
      user: { id: ACTOR_ID, email: "tester@example.com", name: "Tester" },
      account: githubAccount,
      isNewUser: true,
    });

    expect(inserted).toHaveLength(1);
    const serialized = JSON.stringify(inserted);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(ID_TOKEN);
    expect(serialized).not.toContain(SESSION_JWT);
    expect(serialized).not.toContain("access_token");
  });

  it("records a sign-out against the token's user id", async () => {
    const inserted: Record<string, unknown>[] = [];
    const authOptions = await loadAuthOptions(allowAll, inserted);

    await authOptions.events?.signOut?.({
      // biome-ignore lint/suspicious/noExplicitAny: JWT shape is app-defined
      token: { userId: ACTOR_ID, role: "user", email: "tester@example.com" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: unused under the jwt strategy
      session: undefined as any,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actorUserId: ACTOR_ID,
      actionType: "auth_sign_out",
      status: "succeeded",
    });
    expect(JSON.stringify(inserted)).not.toContain("tester@example.com");
  });

  it("records a denied magic-link request with the attempted address", async () => {
    const inserted: Record<string, unknown>[] = [];
    const authOptions = await loadAuthOptions(
      {
        usersSelects: [false],
        existingUserCount: 5,
        pendingInviteForEmail: false,
      },
      inserted,
    );

    const allowed = await authOptions.callbacks?.signIn?.({
      // biome-ignore lint/suspicious/noExplicitAny: adapter-user stub shape
      user: { id: "stranger@example.com", email: "Stranger@Example.com" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: NextAuth's Account type is wider than we use
      account: {
        provider: "email",
        providerAccountId: "stranger@example.com",
        type: "email",
      } as any,
      email: { verificationRequest: true },
      credentials: undefined,
    });

    expect(allowed).toBe(false);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      actorUserId: null,
      actionType: "auth_sign_in_denied",
      status: "denied",
      input: { email: "stranger@example.com" },
      error: "not_invited",
      metadata: {
        authProvider: "email",
        phase: "link_request",
        ip: "203.0.113.7",
      },
    });
  });

  it("records a denied link click as the callback phase", async () => {
    const inserted: Record<string, unknown>[] = [];
    const authOptions = await loadAuthOptions(
      {
        usersSelects: [false],
        existingUserCount: 5,
        pendingInviteForEmail: false,
      },
      inserted,
    );

    await authOptions.callbacks?.signIn?.({
      // biome-ignore lint/suspicious/noExplicitAny: adapter-user stub shape
      user: { id: "stranger@example.com", email: "stranger@example.com" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: NextAuth's Account type is wider than we use
      account: {
        provider: "email",
        providerAccountId: "stranger@example.com",
        type: "email",
      } as any,
      credentials: undefined,
    });

    expect(inserted[0]).toMatchObject({
      actionType: "auth_sign_in_denied",
      metadata: { phase: "callback" },
    });
  });

  it("records a denied GitHub sign-in", async () => {
    const inserted: Record<string, unknown>[] = [];
    const authOptions = await loadAuthOptions(
      {
        usersSelects: [false, false],
        existingUserCount: 5,
        pendingInviteForEmail: false,
      },
      inserted,
    );

    const allowed = await authOptions.callbacks?.signIn?.({
      user: { id: "12345", email: "stranger@example.com", name: "Stranger" },
      account: githubAccount,
      // biome-ignore lint/suspicious/noExplicitAny: profile shape is provider-specific
      profile: { email: "stranger@example.com" } as any,
      credentials: undefined,
    });

    expect(allowed).toBe(false);
    expect(inserted[0]).toMatchObject({
      actionType: "auth_sign_in_denied",
      status: "denied",
      input: { email: "stranger@example.com" },
      error: "not_invited",
      metadata: { authProvider: "github" },
    });
    expect(JSON.stringify(inserted)).not.toContain(ACCESS_TOKEN);
  });

  it("writes nothing when the gate allows the sign-in", async () => {
    const inserted: Record<string, unknown>[] = [];
    const authOptions = await loadAuthOptions(allowAll, inserted);

    const allowed = await authOptions.callbacks?.signIn?.({
      user: { id: "12345", email: "tester@example.com", name: "Tester" },
      account: githubAccount,
      // biome-ignore lint/suspicious/noExplicitAny: profile shape is provider-specific
      profile: { email: "tester@example.com" } as any,
      credentials: undefined,
    });

    // The success row comes from `events.signIn`, not the gate.
    expect(allowed).toBe(true);
    expect(inserted).toHaveLength(0);
  });

});

describe("nextauth — session policy", () => {
  it("pins an explicit 24h idle session instead of the 30-day default", async () => {
    const authOptions = await loadAuthOptions(allowAll, []);
    const {
      SESSION_MAX_AGE_SECONDS,
      SESSION_UPDATE_AGE_SECONDS,
    } = await import("@/lib/auth/nextauth");

    expect(SESSION_MAX_AGE_SECONDS).toBe(24 * 60 * 60);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(60 * 60);
    expect(authOptions.session).toEqual({
      strategy: "jwt",
      maxAge: 24 * 60 * 60,
      updateAge: 60 * 60,
    });
  });
});
