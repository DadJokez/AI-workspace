import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditLog,
  createDb,
  userGroups,
  users,
  type Database,
} from "@ai-workspace/db";
import { asc, eq, like, or, sql } from "drizzle-orm";
import {
  startOidcMockIssuer,
  type AuthorizeOptions,
  type OidcMockIssuer,
} from "./fixtures/oidc-mock-issuer";

/**
 * Koch migration WP-17: OIDC sign-in end to end. next-auth's own handler runs
 * the authorization-code flow (PKCE, state, nonce, ID-token verification by
 * openid-client) against a local mock issuer, and the sign-in gate writes to
 * real Postgres. Nothing here reaches the network.
 *
 * Settings are read when the auth module loads, so each `describe` loads the
 * app once with its own environment.
 *
 * Suites skip (not fail) when no DATABASE_URL is provided, matching the
 * scoping suite.
 */

const DB_URL = process.env.DATABASE_URL;
const suite = describe.skipIf(!DB_URL);

const APP_URL = "http://localhost:3000";
const DOMAIN = "oidc-it.example.com";
const SUB = "oidc-it-";
const USERS_GROUP = "comparative-users";
const ADMINS_GROUP = "comparative-admins";
const SESSION_COOKIE = "next-auth.session-token";

interface SignInResult {
  /** Where next-auth sent the browser after the callback. */
  redirect: string;
  /** The decoded session, or null when no session cookie was issued. */
  session: {
    userId?: string;
    role?: string;
    email?: string | null;
    sv?: number;
  } | null;
}

interface App {
  signIn(options: AuthorizeOptions): Promise<SignInResult>;
  authOptions: typeof import("@/lib/auth/nextauth").authOptions;
  close(): Promise<void>;
}

async function loadApp(
  issuer: OidcMockIssuer,
  env: Record<string, string>,
): Promise<App> {
  vi.resetModules();
  vi.unstubAllEnvs();
  const settings: Record<string, string> = {
    NEXTAUTH_URL: APP_URL,
    NEXTAUTH_SECRET: "oidc-integration-test-secret-with-enough-length",
    AUTH_PROVIDERS: "pingone,email",
    OIDC_ISSUER: issuer.issuer,
    OIDC_CLIENT_ID: issuer.clientId,
    OIDC_CLIENT_SECRET: issuer.clientSecret,
    ...env,
  };
  for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);

  const { authOptions } = await import("@/lib/auth/nextauth");
  const { default: NextAuth } = await import("next-auth");
  const { decode } = await import("next-auth/jwt");
  const { closeDb } = await import("@ai-workspace/db");

  /**
   * One request through next-auth's own handler, in its API-route form: that
   * entry point takes plain request and response objects, where the App
   * Router form reads `next/headers` and needs a running Next.js server.
   */
  async function call(
    path: string,
    cookies: Record<string, string>,
    body?: Record<string, string>,
  ): Promise<{ redirect: string; body: unknown }> {
    const [route, search = ""] = path.split("?");
    const headers: Record<string, string | string[]> = {};
    const result = { redirect: "", body: undefined as unknown };
    const res = {
      status: () => res,
      getHeader: (name: string) => headers[name],
      setHeader(name: string, value: string | string[]) {
        headers[name] = value;
        return res;
      },
      end: () => undefined,
      json(value: unknown) {
        result.body = value;
      },
      send(value: unknown) {
        result.body = value;
      },
    };
    await NextAuth(
      {
        method: body ? "POST" : "GET",
        query: {
          nextauth: route!.split("/"),
          ...Object.fromEntries(new URLSearchParams(search)),
        },
        body,
        cookies,
        headers: { host: new URL(APP_URL).host },
      } as never,
      res as never,
      authOptions,
    );
    for (const header of [headers["Set-Cookie"] ?? []].flat()) {
      const [pair = ""] = header.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      cookies[name] = decodeURIComponent(pair.slice(name.length + 1));
    }
    result.redirect = String(headers.Location ?? "");
    return result;
  }

  return {
    authOptions,
    close: closeDb,
    async signIn(options) {
      const cookies: Record<string, string> = {};
      const csrf = await call("csrf", cookies);
      const start = await call("signin/pingone", cookies, {
        csrfToken: (csrf.body as { csrfToken: string }).csrfToken,
        callbackUrl: `${APP_URL}/chat`,
      });
      const code = issuer.authorize(start.redirect, options);
      const state = new URL(start.redirect).searchParams.get("state") ?? "";
      const done = await call(
        `callback/pingone?code=${code}&state=${encodeURIComponent(state)}`,
        cookies,
      );
      const token = cookies[SESSION_COOKIE];
      return {
        redirect: done.redirect,
        session: token
          ? await decode({ token, secret: settings.NEXTAUTH_SECRET! })
          : null,
      };
    },
  };
}

suite("OIDC sign-in (mock issuer, real Postgres)", () => {
  const db: Database = createDb({ url: DB_URL ?? "", max: 2 });
  let issuer: OidcMockIssuer;

  const address = (name: string) => `${name}@${DOMAIN}`;
  const claims = (name: string, extra: Record<string, unknown> = {}) => ({
    sub: `${SUB}${name}`,
    email: address(name),
    name: `Test ${name}`,
    ...extra,
  });

  async function userBySubject(subject: string) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.pingSubject, subject));
    return rows[0];
  }
  const oidcUser = (name: string) => userBySubject(`pingone:${SUB}${name}`);

  async function usersWithAddress(name: string) {
    return db
      .select()
      .from(users)
      .where(eq(users.email, address(name)))
      .orderBy(asc(users.pingSubject));
  }

  async function groupsOf(userId: string) {
    const rows = await db
      .select({ groupName: userGroups.groupName })
      .from(userGroups)
      .where(eq(userGroups.userId, userId))
      .orderBy(asc(userGroups.groupName));
    return rows.map((row) => row.groupName);
  }

  /** Auth audit rows about one user or one attempted address, oldest first. */
  async function auditRows(filter: { userId?: string; email?: string }) {
    return db
      .select({
        actionType: auditLog.actionType,
        status: auditLog.status,
        error: auditLog.error,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        filter.userId
          ? eq(auditLog.actorUserId, filter.userId)
          : sql`${auditLog.input}->>'email' = ${filter.email ?? ""}`,
      )
      .orderBy(asc(auditLog.createdAt));
  }

  async function cleanup() {
    await db
      .delete(auditLog)
      .where(sql`${auditLog.input}->>'email' like ${`%@${DOMAIN}`}`);
    const mine = await db
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          like(users.email, `%@${DOMAIN}`),
          like(users.pingSubject, `pingone:${SUB}%`),
        ),
      );
    for (const { id } of mine) {
      await db.delete(auditLog).where(eq(auditLog.actorUserId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  }

  beforeAll(async () => {
    issuer = await startOidcMockIssuer();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await issuer.close();
    vi.unstubAllEnvs();
  });

  describe("with a required group and an admin group", () => {
    let app: App;
    beforeAll(async () => {
      app = await loadApp(issuer, {
        OIDC_REQUIRED_GROUP: USERS_GROUP,
        OIDC_ADMIN_GROUP: ADMINS_GROUP,
      });
    });
    afterAll(() => app.close());

    it("creates a pingone: user, signs them in and records it", async () => {
      const result = await app.signIn({
        claims: claims("alice", { groups: [USERS_GROUP, "engineering"] }),
      });

      expect(result.redirect).toBe(`${APP_URL}/chat`);
      const row = await oidcUser("alice");
      expect(row).toMatchObject({
        email: address("alice"),
        displayName: "Test alice",
        role: "user",
      });
      expect(result.session).toMatchObject({
        userId: row!.id,
        role: "user",
        email: address("alice"),
      });
      expect(await groupsOf(row!.id)).toEqual([USERS_GROUP, "engineering"]);
      expect(await auditRows({ userId: row!.id })).toEqual([
        expect.objectContaining({
          actionType: "auth_sign_in",
          status: "succeeded",
          metadata: expect.objectContaining({
            authProvider: "pingone",
            isNewUser: true,
          }),
        }),
      ]);
    });

    it("stamps the session version at sign-in and refuses a suspended user without touching the row (WP-18)", async () => {
      const first = await app.signIn({
        claims: claims("sid", { groups: [USERS_GROUP, ADMINS_GROUP] }),
      });
      const row = await oidcUser("sid");
      expect(first.session).toMatchObject({ userId: row!.id, sv: 0 });

      await db
        .update(users)
        .set({ status: "suspended", sessionVersion: 1 })
        .where(eq(users.id, row!.id));
      // The claim would now demote them; a refused sign-in syncs nothing.
      const refused = await app.signIn({
        claims: claims("sid", { groups: [USERS_GROUP] }),
      });
      expect(refused.redirect).toBe(
        `${APP_URL}/login?error=AccessDenied&reason=user_inactive`,
      );
      expect(refused.session).toBeNull();
      expect(await oidcUser("sid")).toMatchObject({
        status: "suspended",
        role: "admin",
      });
      expect(await groupsOf(row!.id)).toEqual([ADMINS_GROUP, USERS_GROUP]);
      expect(
        (await auditRows({ email: address("sid") })).map((entry) => entry.error),
      ).toContain("user_inactive");

      await db
        .update(users)
        .set({ status: "active" })
        .where(eq(users.id, row!.id));
      const again = await app.signIn({
        claims: claims("sid", { groups: [USERS_GROUP] }),
      });
      expect(again.session).toMatchObject({ userId: row!.id, sv: 1 });
    });

    it("asks the issuer for the configured scope with PKCE, state and a nonce", async () => {
      let authorizationUrl = "";
      const authorize = issuer.authorize;
      issuer.authorize = (url, options) => {
        authorizationUrl = url;
        return authorize(url, options);
      };
      try {
        await app.signIn({ claims: claims("scope", { groups: [USERS_GROUP] }) });
      } finally {
        issuer.authorize = authorize;
      }
      const params = new URL(authorizationUrl).searchParams;
      expect(params.get("scope")).toBe("openid profile email");
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("state")).toBeTruthy();
      expect(params.get("nonce")).toBeTruthy();
      expect(params.get("redirect_uri")).toBe(
        `${APP_URL}/api/auth/callback/pingone`,
      );
    });

    it("makes a member of the admin group an admin, and a user again once removed", async () => {
      const inGroup = await app.signIn({
        claims: claims("bob", { groups: [USERS_GROUP, ADMINS_GROUP] }),
      });
      expect(inGroup.session?.role).toBe("admin");
      const row = await oidcUser("bob");
      expect(row?.role).toBe("admin");

      const removed = await app.signIn({
        claims: claims("bob", { groups: [USERS_GROUP] }),
      });
      expect(removed.session?.role).toBe("user");
      expect((await oidcUser("bob"))?.role).toBe("user");

      const synced = (await auditRows({ userId: row!.id })).filter(
        (entry) => entry.actionType === "auth_role_synced",
      );
      expect(synced.map((entry) => entry.metadata)).toEqual([
        expect.objectContaining({ previousRole: "user", newRole: "admin" }),
        expect.objectContaining({ previousRole: "admin", newRole: "user" }),
      ]);
    });

    it("demotes an admin whose groups claim stops arriving in a readable form", async () => {
      await app.signIn({
        claims: claims("carol", { groups: [USERS_GROUP, ADMINS_GROUP] }),
      });
      expect((await oidcUser("carol"))?.role).toBe("admin");

      // Still admitted (the claim is readable and holds the required group),
      // but the admin group entry is gone.
      await app.signIn({ claims: claims("carol", { groups: [USERS_GROUP] }) });
      expect((await oidcUser("carol"))?.role).toBe("user");
    });

    it.each([
      ["not in the required group", { groups: ["engineering"] }, "required_group_missing"],
      ["an empty groups claim", { groups: [] }, "required_group_missing"],
      ["no groups claim", {}, "groups_claim_unreadable"],
      ["a groups claim that is not a list", { groups: { [USERS_GROUP]: true } }, "groups_claim_unreadable"],
      ["a groups list with a non-string entry", { groups: [USERS_GROUP, 7] }, "groups_claim_unreadable"],
      ["the admin group alone", { groups: [ADMINS_GROUP] }, "required_group_missing"],
    ])("denies %s, creates no user and audits why", async (_label, extra, reason) => {
      const logs = ["log", "warn", "error"].map((level) =>
        vi.spyOn(console, level as "log").mockImplementation(() => {}),
      );
      const result = await app.signIn({ claims: claims("denied", extra) });
      // A refusal is recorded in the ledger, not printed: no claim reaches a log.
      for (const log of logs) {
        expect(log).not.toHaveBeenCalled();
        log.mockRestore();
      }

      expect(result.session).toBeNull();
      expect(result.redirect).toBe(
        `${APP_URL}/login?error=AccessDenied&reason=${reason}`,
      );
      expect(await oidcUser("denied")).toBeUndefined();
      expect(await auditRows({ email: address("denied") })).toEqual([
        expect.objectContaining({
          actionType: "auth_sign_in_denied",
          status: "denied",
          error: reason,
          metadata: expect.objectContaining({ authProvider: "pingone" }),
        }),
      ]);
    });

    it("locks out an existing user who has left the required group, keeping their row", async () => {
      await app.signIn({ claims: claims("dave", { groups: [USERS_GROUP] }) });
      const before = await oidcUser("dave");

      const result = await app.signIn({
        claims: claims("dave", { groups: ["engineering"] }),
      });
      expect(result.session).toBeNull();
      // A refused sign-in changes nothing: same row, same groups on record.
      expect(await oidcUser("dave")).toMatchObject({ id: before!.id });
      expect(await groupsOf(before!.id)).toEqual([USERS_GROUP]);
    });

    it("reads a single group sent as a bare string", async () => {
      const result = await app.signIn({
        claims: claims("erin", { groups: USERS_GROUP }),
      });
      expect(result.session?.role).toBe("user");
      expect(await groupsOf((await oidcUser("erin"))!.id)).toEqual([
        USERS_GROUP,
      ]);
    });

    it("takes the groups claim from userinfo when the ID token has none", async () => {
      const result = await app.signIn({
        claims: claims("frank"),
        userinfo: {
          sub: `${SUB}frank`,
          groups: [USERS_GROUP, ADMINS_GROUP],
          // Identity claims in userinfo are ignored: the signed token wins.
          email: address("someone-else"),
        },
      });
      expect(result.session).toMatchObject({
        role: "admin",
        email: address("frank"),
      });
    });

    it("ignores a userinfo answer for a different subject", async () => {
      const result = await app.signIn({
        claims: claims("grace"),
        userinfo: { sub: `${SUB}mallory`, groups: [USERS_GROUP, ADMINS_GROUP] },
      });
      expect(result.session).toBeNull();
      expect(result.redirect).toContain("reason=groups_claim_unreadable");
    });

    it("replaces the stored groups on every sign-in", async () => {
      await app.signIn({
        claims: claims("heidi", { groups: [USERS_GROUP, "engineering", "oncall"] }),
      });
      const row = await oidcUser("heidi");
      expect(await groupsOf(row!.id)).toEqual([USERS_GROUP, "engineering", "oncall"]);

      await app.signIn({
        claims: claims("heidi", { groups: [USERS_GROUP, "finance"] }),
      });
      expect(await groupsOf(row!.id)).toEqual([USERS_GROUP, "finance"]);
    });

    it("keeps two people with one address and different subjects as two users", async () => {
      const shared = { email: address("shared"), groups: [USERS_GROUP] };
      const first = await app.signIn({ claims: claims("ivan", shared) });
      const second = await app.signIn({ claims: claims("judy", shared) });

      expect(first.session?.userId).toBeTruthy();
      expect(second.session?.userId).toBeTruthy();
      expect(second.session?.userId).not.toBe(first.session?.userId);
      expect((await usersWithAddress("shared")).map((u) => u.pingSubject)).toEqual([
        `pingone:${SUB}ivan`,
        `pingone:${SUB}judy`,
      ]);
    });

    it("does not adopt a magic-link user by address when adoption is off, even with a verified address", async () => {
      const [pilot] = await db
        .insert(users)
        .values({
          pingSubject: `email:${address("pilot")}`,
          email: address("pilot"),
          displayName: "Pilot",
          role: "admin",
        })
        .returning();

      const result = await app.signIn({
        claims: claims("pilot", { groups: [USERS_GROUP], email_verified: true }),
      });

      const rows = await usersWithAddress("pilot");
      expect(rows.map((u) => u.pingSubject)).toEqual([
        `email:${address("pilot")}`,
        `pingone:${SUB}pilot`,
      ]);
      // A fresh, separate user: the magic-link admin's role is not inherited.
      expect(result.session?.userId).not.toBe(pilot!.id);
      expect(result.session?.role).toBe("user");
      expect((await userBySubject(`email:${address("pilot")}`))?.role).toBe("admin");
    });

    it.each([
      ["an ID token signed with a key the issuer does not publish", { forgedSignature: true }, {}],
      ["an ID token carrying the wrong nonce", { wrongNonce: true }, {}],
      ["an ID token with no subject", {}, { sub: undefined }],
    ])("rejects %s before the gate runs, and logs no secret", async (_label, tamper, extra) => {
      // next-auth reports the failed token validation on the error log.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await app.signIn({
        claims: {
          ...claims("forged", { groups: [USERS_GROUP, ADMINS_GROUP] }),
          ...extra,
        },
        ...tamper,
      });
      const output = logged.mock.calls.flat().map(String).join("\n");
      logged.mockRestore();

      expect(result.session).toBeNull();
      expect(result.redirect).toBe(`${APP_URL}/api/auth/error?error=OAuthCallback`);
      expect(await oidcUser("forged")).toBeUndefined();
      expect(output).toContain("OAUTH_CALLBACK_ERROR");
      expect(output).not.toContain(issuer.clientSecret);
    });

    it.each([
      ["an oversized subject", { sub: "s".repeat(300) }, "invalid_subject"],
      ["no email address", { email: undefined }, "missing_email"],
      ["an email claim that is not a string", { email: { address: "x" } }, "missing_email"],
    ])("denies claims with %s", async (_label, extra, reason) => {
      const result = await app.signIn({
        claims: { ...claims("bad", { groups: [USERS_GROUP] }), ...extra },
      });
      expect(result.session).toBeNull();
      expect(result.redirect).toBe(
        `${APP_URL}/login?error=AccessDenied&reason=${reason}`,
      );
      expect(await oidcUser("bad")).toBeUndefined();
    });

    it("never signs a magic link in as an OIDC user, and never re-keys one", async () => {
      await app.signIn({ claims: claims("kim", { groups: [USERS_GROUP] }) });
      const row = await oidcUser("kim");
      const adapter = app.authOptions.adapter!;

      // The magic-link flow resolves users through getUserByEmail.
      expect(await adapter.getUserByEmail!(address("kim"))).toBeNull();
      await expect(
        adapter.linkAccount!({
          userId: row!.id,
          provider: "github",
          providerAccountId: "oidc-it-github-1",
          type: "oauth",
        }),
      ).rejects.toThrow("linkAccount refused");
      expect((await oidcUser("kim"))?.id).toBe(row!.id);
    });

    it("rolls back the role and the groups together when the sign-in transaction fails", async () => {
      await app.signIn({
        claims: claims("lena", { groups: [USERS_GROUP, ADMINS_GROUP] }),
      });
      const row = await oidcUser("lena");
      const { provisionOidcUser } = await import("@/lib/auth/oidc-sign-in");
      const { getDb } = await import("@ai-workspace/db");

      // A NUL byte is something Postgres refuses to store: the group insert
      // fails after the role update and the old rows' delete have run.
      await expect(
        provisionOidcUser(
          getDb(),
          {
            subject: row!.pingSubject,
            email: row!.email,
            emailVerified: false,
            displayName: row!.displayName,
            groups: ["engineering", "bad\u0000group"],
          },
          { adminGroup: ADMINS_GROUP, adoptEmailUsers: false },
        ),
      ).rejects.toThrow();

      expect((await oidcUser("lena"))?.role).toBe("admin");
      expect(await groupsOf(row!.id)).toEqual([ADMINS_GROUP, USERS_GROUP]);
    });
  });

  describe("with adoption on and no group settings", () => {
    let app: App;
    beforeAll(async () => {
      app = await loadApp(issuer, { OIDC_ADOPT_EMAIL_USERS: "1" });
    });
    afterAll(() => app.close());

    async function seedUser(name: string, pingSubject: string) {
      const [row] = await db
        .insert(users)
        .values({
          pingSubject,
          email: address(name),
          displayName: `Pilot ${name}`,
          role: "admin",
        })
        .returning();
      return row!;
    }

    it("adopts the magic-link user when the identity provider says the address is verified", async () => {
      const pilot = await seedUser("mia", `email:${address("mia")}`);

      const result = await app.signIn({
        // The claim's casing differs; the match is on the lower-cased address.
        claims: claims("mia", {
          email: address("mia").toUpperCase(),
          email_verified: true,
        }),
      });

      expect(result.session?.userId).toBe(pilot.id);
      const rows = await usersWithAddress("mia");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: pilot.id,
        pingSubject: `pingone:${SUB}mia`,
        // Kept: no admin group is configured, so the stored role stands.
        role: "admin",
        displayName: "Pilot mia",
      });
      const actions = (await auditRows({ userId: pilot.id })).map(
        (entry) => entry.actionType,
      );
      expect(actions).toEqual(["auth_identity_adopted", "auth_sign_in"]);
    });

    it.each([
      ["email_verified is false", { email_verified: false }],
      ["email_verified is absent", {}],
      ["email_verified is the string \"true\"", { email_verified: "true" }],
    ])("does not adopt when %s", async (_label, extra) => {
      const pilot = await seedUser("nora", `email:${address("nora")}`);

      const result = await app.signIn({ claims: claims("nora", extra) });

      expect(result.session?.userId).toBeTruthy();
      expect(result.session?.userId).not.toBe(pilot.id);
      expect(result.session?.role).toBe("user");
      expect((await usersWithAddress("nora")).map((u) => u.pingSubject)).toEqual([
        `email:${address("nora")}`,
        `pingone:${SUB}nora`,
      ]);
    });

    it("neither adopts a suspended magic-link user nor gives them a fresh account (WP-18)", async () => {
      const pilot = await seedUser("sue", `email:${address("sue")}`);
      await db
        .update(users)
        .set({ status: "suspended" })
        .where(eq(users.id, pilot.id));

      const result = await app.signIn({
        claims: claims("sue", { email_verified: true }),
      });

      expect(result.redirect).toBe(
        `${APP_URL}/login?error=AccessDenied&reason=user_inactive`,
      );
      expect(result.session).toBeNull();
      expect((await usersWithAddress("sue")).map((u) => u.pingSubject)).toEqual([
        `email:${address("sue")}`,
      ]);
    });

    it("does not adopt a user whose identity is a GitHub account", async () => {
      const github = await seedUser("omar", "oidc-it-github-omar");

      const result = await app.signIn({
        claims: claims("omar", { email_verified: true }),
      });

      expect(result.session?.userId).not.toBe(github.id);
      expect((await userBySubject("oidc-it-github-omar"))?.id).toBe(github.id);
    });

    it("admits any authenticated user and never changes a role when no groups are configured", async () => {
      const result = await app.signIn({ claims: claims("pat") });
      expect(result.session?.role).toBe("user");

      const row = await oidcUser("pat");
      await db.update(users).set({ role: "admin" }).where(eq(users.id, row!.id));
      const again = await app.signIn({ claims: claims("pat") });
      expect(again.session?.role).toBe("admin");
    });
  });
});
