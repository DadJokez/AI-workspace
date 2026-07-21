import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, users, verificationTokens } from "@ai-workspace/db";
import { like, or, sql } from "drizzle-orm";

/**
 * Verification-token lifecycle and adapter/user mapping against real
 * Postgres — create/use/expire/single-use is a DELETE ... RETURNING
 * contract that the unit-lane mocks can't prove.
 *
 * Suites skip (not fail) when no DATABASE_URL is provided, matching the
 * scoping suite.
 */

const DB_URL = process.env.DATABASE_URL;

const suite = describe.skipIf(!DB_URL);

suite("nextauth adapter (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 2 });

  // The adapter module uses getDb() (env-bound singleton). DATABASE_URL is
  // forwarded by vitest.integration.config.ts, so both handles point at the
  // same database.
  async function loadAdapter() {
    const { createNextAuthAdapter } = await import(
      "@/lib/auth/nextauth-adapter"
    );
    return createNextAuthAdapter();
  }

  async function cleanup() {
    await db
      .delete(verificationTokens)
      .where(like(verificationTokens.identifier, "%adapter-it.example.com"));
    await db
      .delete(users)
      .where(
        or(
          like(users.email, "%adapter-it.example.com"),
          like(users.pingSubject, "adapter-it-%"),
        ),
      );
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  it("roundtrips a verification token: create, single use, then gone", async () => {
    const adapter = await loadAdapter();
    const token = {
      identifier: "tester@adapter-it.example.com",
      token: "hashed-token-value",
      expires: new Date(Date.now() + 15 * 60 * 1000),
    };

    await adapter.createVerificationToken?.(token);

    const used = await adapter.useVerificationToken?.({
      identifier: token.identifier,
      token: token.token,
    });
    expect(used).toMatchObject({
      identifier: token.identifier,
      token: token.token,
    });
    expect(used?.expires.getTime()).toBe(token.expires.getTime());

    // Single-use: the same token can never be redeemed twice.
    const secondUse = await adapter.useVerificationToken?.({
      identifier: token.identifier,
      token: token.token,
    });
    expect(secondUse).toBeNull();
  });

  it("returns expired tokens with their expiry intact so next-auth core rejects them", async () => {
    const adapter = await loadAdapter();
    const expired = {
      identifier: "expired@adapter-it.example.com",
      token: "expired-token",
      expires: new Date(Date.now() - 60 * 1000),
    };
    await db.insert(verificationTokens).values(expired);

    const used = await adapter.useVerificationToken?.({
      identifier: expired.identifier,
      token: expired.token,
    });
    // The adapter's contract is retrieval + burn; expiry enforcement lives in
    // next-auth core (`invite.expires.valueOf() < Date.now()`).
    expect(used?.expires.getTime()).toBeLessThan(Date.now());
  });

  it("does not match a token issued to a different identifier", async () => {
    const adapter = await loadAdapter();
    await adapter.createVerificationToken?.({
      identifier: "alice@adapter-it.example.com",
      token: "alice-token",
      expires: new Date(Date.now() + 15 * 60 * 1000),
    });

    const crossUse = await adapter.useVerificationToken?.({
      identifier: "mallory@adapter-it.example.com",
      token: "alice-token",
    });
    expect(crossUse).toBeNull();
  });

  it("sweeps this identifier's expired never-clicked tokens when a new link is created", async () => {
    const adapter = await loadAdapter();
    const identifier = "sweep@adapter-it.example.com";
    await db.insert(verificationTokens).values({
      identifier,
      token: "stale-token",
      expires: new Date(Date.now() - 60 * 1000),
    });

    await adapter.createVerificationToken?.({
      identifier,
      token: "fresh-token",
      expires: new Date(Date.now() + 15 * 60 * 1000),
    });

    const rows = await db
      .select()
      .from(verificationTokens)
      .where(sql`${verificationTokens.identifier} = ${identifier}`);
    expect(rows.map((r) => r.token)).toEqual(["fresh-token"]);
  });

  it("maps users by email case-insensitively and by account subject, and createUser applies ensureUser semantics", async () => {
    const adapter = await loadAdapter();

    const created = await adapter.createUser?.({
      email: "NewTester@adapter-it.example.com",
      emailVerified: new Date(),
    });
    expect(created?.email).toBe("NewTester@adapter-it.example.com");

    const byEmail = await adapter.getUserByEmail?.(
      "newtester@adapter-it.example.com",
    );
    expect(byEmail?.id).toBe(created?.id);

    // Magic-link-created users carry the email-derived subject until an
    // OAuth linkAccount replaces it.
    const byAccount = await adapter.getUserByAccount?.({
      provider: "email",
      providerAccountId: "email:newtester@adapter-it.example.com",
    });
    expect(byAccount?.id).toBe(created?.id);

    await adapter.linkAccount?.({
      userId: created!.id,
      provider: "github",
      providerAccountId: "adapter-it-gh-123",
      type: "oauth",
    });
    const byGithub = await adapter.getUserByAccount?.({
      provider: "github",
      providerAccountId: "adapter-it-gh-123",
    });
    expect(byGithub?.id).toBe(created!.id);

    const fetched = await adapter.getUser?.(created!.id);
    expect(fetched?.email).toBe("NewTester@adapter-it.example.com");

    const touched = await adapter.updateUser?.({
      id: created!.id,
      emailVerified: new Date(),
    });
    expect(touched?.id).toBe(created!.id);
  });
});
