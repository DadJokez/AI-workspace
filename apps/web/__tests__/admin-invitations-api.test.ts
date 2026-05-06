import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * Tests for /api/admin/invitations. Mirrors admin-users-api.test.ts —
 * mock auth + drizzle so we can assert routing, gating, and the shape of
 * the generated token without needing a database.
 */

const adminSession: SessionUser = {
  id: "admin-uuid",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};

const userSession: SessionUser = {
  id: "user-uuid",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

const fixedDate = new Date("2026-01-01T00:00:00Z");

interface DbHooks {
  insertReturning?: Array<Record<string, unknown>>;
  selectRows?: Array<Record<string, unknown>>;
  onInsertValues?: (values: Record<string, unknown>) => void;
}

let dbHooks: DbHooks = {};

function setSession(user: SessionUser | null) {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => user,
  }));
}

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
          if (prop === "values") {
            return (v: Record<string, unknown>) => {
              dbHooks.onInsertValues?.(v);
              return proxy;
            };
          }
          if (prop === "returning") {
            return () => Promise.resolve(dbHooks.insertReturning ?? []);
          }
          if (prop === "orderBy") {
            return () => Promise.resolve(dbHooks.selectRows ?? []);
          }
          return () => proxy;
        },
      },
    );

    return {
      ...actual,
      getDb: () => proxy as never,
    };
  });
}

beforeEach(() => {
  dbHooks = {};
  process.env.NEXTAUTH_URL = "https://example.com";
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("POST /api/admin/invitations", () => {
  function makeReq(body: unknown) {
    return new Request("http://localhost/api/admin/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 403 when the session role is 'user'", async () => {
    setSession(userSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makeReq({ email: "x@example.com", role: "user" }));
    expect(res.status).toBe(403);
  });

  it("returns 401 when there is no session", async () => {
    setSession(null);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makeReq({ email: "x@example.com", role: "user" }));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid email", async () => {
    setSession(adminSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makeReq({ email: "not-an-email", role: "user" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_email");
  });

  it("creates an invite with a 64-char hex token and returns the inviteUrl", async () => {
    setSession(adminSession);
    installDbMock();

    let captured: Record<string, unknown> | undefined;
    dbHooks.onInsertValues = (v) => {
      captured = v;
    };
    // The route returns whatever .returning() yields; we echo the token back
    // so the URL assertion can compare it.
    dbHooks.insertReturning = [
      {
        id: "invite-uuid",
        email: "new@example.com",
        role: "user",
        // token will be set after capture; we'll use a placeholder here and
        // overwrite the assertion below by reading the captured value.
        token: "placeholder",
        expiresAt: fixedDate,
        createdAt: fixedDate,
      },
    ];

    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makeReq({ email: "  NEW@Example.com  ", role: "user" }),
    );
    expect(res.status).toBe(201);

    const token = captured?.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // Email normalized to lower-case + trimmed.
    expect(captured?.email).toBe("new@example.com");
    // expires_at is ~7d in the future.
    const expiresAt = captured?.expiresAt as Date;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const skew = Math.abs(expiresAt.getTime() - (Date.now() + sevenDays));
    expect(skew).toBeLessThan(5_000);
    // invitedBy is the admin's id.
    expect(captured?.invitedBy).toBe("admin-uuid");
  });

  it("defaults role to 'user' when an unknown value is given", async () => {
    setSession(adminSession);
    installDbMock();

    let captured: Record<string, unknown> | undefined;
    dbHooks.onInsertValues = (v) => {
      captured = v;
    };
    dbHooks.insertReturning = [
      {
        id: "invite-uuid",
        email: "x@example.com",
        role: "user",
        token: "t",
        expiresAt: fixedDate,
        createdAt: fixedDate,
      },
    ];

    const { POST } = await import("@/app/api/admin/invitations/route");
    await POST(makeReq({ email: "x@example.com", role: "superuser" }));
    expect(captured?.role).toBe("user");
  });
});

describe("GET /api/admin/invitations", () => {
  it("returns 403 when the session role is 'user'", async () => {
    setSession(userSession);
    installDbMock();
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(new Request("http://localhost/api/admin/invitations"));
    expect(res.status).toBe(403);
  });

  it("returns the pending invitations list for an admin", async () => {
    setSession(adminSession);
    installDbMock();
    dbHooks.selectRows = [
      {
        id: "invite-1",
        email: "a@example.com",
        role: "user",
        token: "abc",
        expiresAt: fixedDate,
        createdAt: fixedDate,
      },
    ];

    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(new Request("http://localhost/api/admin/invitations"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitations: Array<{ inviteUrl: string; expiresAt: string }>;
    };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]?.inviteUrl).toBe(
      "https://example.com/invite/abc",
    );
    expect(body.invitations[0]?.expiresAt).toBe(fixedDate.toISOString());
  });
});
