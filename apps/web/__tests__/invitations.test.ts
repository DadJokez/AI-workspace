import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Direct tests for the invitations lib. We swap out `getDb` from
 * `@ai-workspace/db` with a Proxy-based fake whose terminal methods
 * (`limit`, `orderBy`, `returning`, awaited counts) resolve to canned data.
 *
 * Covers `lookupInvitationByToken` (each status branch),
 * `consumePendingInvitationForEmail` (claim path + already-used path), and
 * the `inviteUrlFor` env-var fallback chain.
 */

interface DbSeed {
  /** Rows returned by the leading `select().from(invitations).where(...).limit(1)` (or `.orderBy().limit(1)`). */
  selectLimit?: unknown[];
  /** Captured set value for `.update(invitations).set(...)`. */
  onSet?: (s: Record<string, unknown>) => void;
  /** Rows returned by `.returning()` after an update/insert. */
  returning?: unknown[];
}

let seed: DbSeed = {};

function installDbMock() {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "limit") return () => Promise.resolve(seed.selectLimit ?? []);
          if (prop === "set")
            return (s: Record<string, unknown>) => {
              seed.onSet?.(s);
              return proxy;
            };
          if (prop === "returning")
            return () => Promise.resolve(seed.returning ?? []);
          return () => proxy;
        },
      },
    );

    return { ...actual, getDb: () => proxy as never };
  });
}

afterEach(() => {
  seed = {};
  vi.resetModules();
  delete process.env.NEXTAUTH_URL;
  delete process.env.APP_BASE_URL;
});

describe("lookupInvitationByToken", () => {
  it("returns 'not_found' when no row exists", async () => {
    seed.selectLimit = [];
    installDbMock();
    const { lookupInvitationByToken } = await import("@/lib/invitations");
    const r = await lookupInvitationByToken("missing");
    expect(r.status).toBe("not_found");
    expect(r.invitation).toBeUndefined();
  });

  it("returns 'expired' when expires_at is in the past", async () => {
    seed.selectLimit = [
      {
        id: "i1",
        email: "x@y.com",
        role: "user",
        token: "tok",
        invitedBy: "u1",
        acceptedAt: null,
        expiresAt: new Date("2020-01-01T00:00:00Z"),
        createdAt: new Date("2019-12-25T00:00:00Z"),
      },
    ];
    installDbMock();
    const { lookupInvitationByToken } = await import("@/lib/invitations");
    const r = await lookupInvitationByToken("tok");
    expect(r.status).toBe("expired");
  });

  it("returns 'accepted' when accepted_at is set", async () => {
    seed.selectLimit = [
      {
        id: "i1",
        email: "x@y.com",
        role: "user",
        token: "tok",
        invitedBy: "u1",
        acceptedAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        createdAt: new Date("2025-12-25T00:00:00Z"),
      },
    ];
    installDbMock();
    const { lookupInvitationByToken } = await import("@/lib/invitations");
    const r = await lookupInvitationByToken("tok");
    expect(r.status).toBe("accepted");
  });

  it("returns 'valid' for a pending, unexpired invitation", async () => {
    seed.selectLimit = [
      {
        id: "i1",
        email: "x@y.com",
        role: "admin",
        token: "tok",
        invitedBy: "u1",
        acceptedAt: null,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    installDbMock();
    const { lookupInvitationByToken } = await import("@/lib/invitations");
    const r = await lookupInvitationByToken("tok");
    expect(r.status).toBe("valid");
    expect(r.invitation?.role).toBe("admin");
  });
});

describe("consumePendingInvitationForEmail", () => {
  it("returns null when no pending invitation matches", async () => {
    seed.selectLimit = [];
    installDbMock();
    const { consumePendingInvitationForEmail } = await import(
      "@/lib/invitations"
    );
    const role = await consumePendingInvitationForEmail("nobody@example.com");
    expect(role).toBeNull();
  });

  it("claims the pending invitation and returns its role on first call", async () => {
    seed.selectLimit = [{ id: "i1", role: "admin" }];
    let setCaptured: Record<string, unknown> | undefined;
    seed.onSet = (s) => {
      setCaptured = s;
    };
    seed.returning = [{ role: "admin" }];
    installDbMock();
    const { consumePendingInvitationForEmail } = await import(
      "@/lib/invitations"
    );
    const role = await consumePendingInvitationForEmail("x@y.com");
    expect(role).toBe("admin");
    expect(setCaptured?.acceptedAt).toBeInstanceOf(Date);
  });

  it("returns null when the conditional update claims zero rows (race lost)", async () => {
    seed.selectLimit = [{ id: "i1", role: "user" }];
    seed.returning = []; // simulate concurrent consumer beat us to it
    installDbMock();
    const { consumePendingInvitationForEmail } = await import(
      "@/lib/invitations"
    );
    const role = await consumePendingInvitationForEmail("x@y.com");
    expect(role).toBeNull();
  });

  it("matches email case-insensitively", async () => {
    seed.selectLimit = [{ id: "i1", role: "user" }];
    seed.returning = [{ role: "user" }];
    installDbMock();
    const { consumePendingInvitationForEmail } = await import(
      "@/lib/invitations"
    );
    const role = await consumePendingInvitationForEmail("X@Y.COM");
    expect(role).toBe("user");
  });
});

describe("inviteUrlFor", () => {
  it("uses NEXTAUTH_URL when set", async () => {
    process.env.NEXTAUTH_URL = "https://hub.example.com";
    installDbMock();
    const { inviteUrlFor } = await import("@/lib/invitations");
    expect(inviteUrlFor("abc")).toBe("https://hub.example.com/invite/abc");
  });

  it("falls back to APP_BASE_URL", async () => {
    process.env.APP_BASE_URL = "https://app.example.com";
    installDbMock();
    const { inviteUrlFor } = await import("@/lib/invitations");
    expect(inviteUrlFor("abc")).toBe("https://app.example.com/invite/abc");
  });

  it("falls back to the request origin when no env var is set", async () => {
    installDbMock();
    const { inviteUrlFor } = await import("@/lib/invitations");
    expect(inviteUrlFor("abc", "http://localhost:3000/anything")).toBe(
      "http://localhost:3000/invite/abc",
    );
  });

  it("strips a trailing slash from the base URL", async () => {
    process.env.NEXTAUTH_URL = "https://hub.example.com/";
    installDbMock();
    const { inviteUrlFor } = await import("@/lib/invitations");
    expect(inviteUrlFor("abc")).toBe("https://hub.example.com/invite/abc");
  });
});
