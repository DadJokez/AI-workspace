import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * Tests for the admin users API. We mock both `getSessionUser` (the auth
 * gate) and `@ai-workspace/db` (so we never need a real DB). The mocks let
 * us drive the gate behavior and assert that the route returns the right
 * status/body and does/does not call into Drizzle.
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

const sampleRows = [
  {
    id: "admin-uuid",
    email: "admin@example.com",
    displayName: "Admin",
    role: "admin" as const,
    createdAt: fixedDate,
    lastSeenAt: fixedDate,
  },
  {
    id: "user-uuid",
    email: "user@example.com",
    displayName: "User",
    role: "user" as const,
    createdAt: fixedDate,
    lastSeenAt: fixedDate,
  },
];

interface DbHooks {
  selectRows?: typeof sampleRows;
  updateReturning?: typeof sampleRows;
  onUpdateSet?: (set: Record<string, unknown>) => void;
  onUpdateWhereId?: (id: string) => void;
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
          if (prop === "set") {
            return (set: Record<string, unknown>) => {
              dbHooks.onUpdateSet?.(set);
              return proxy;
            };
          }
          if (prop === "where") {
            // drizzle's `eq(users.id, value)` is opaque to us, but the route
            // only ever calls `.where(eq(users.id, id))`, so we extract the
            // bound value via the second positional arg of the eq call.
            return (_predicate: unknown) => {
              return proxy;
            };
          }
          if (prop === "orderBy") {
            return () => Promise.resolve(dbHooks.selectRows ?? sampleRows);
          }
          if (prop === "returning") {
            return () =>
              Promise.resolve(dbHooks.updateReturning ?? sampleRows);
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
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("GET /api/admin/users", () => {
  it("returns 401 when there is no session", async () => {
    setSession(null);
    installDbMock();
    const { GET } = await import("@/app/api/admin/users/route");
    const res = await GET(new Request("http://localhost/api/admin/users"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the session role is 'user'", async () => {
    setSession(userSession);
    installDbMock();
    const { GET } = await import("@/app/api/admin/users/route");
    const res = await GET(new Request("http://localhost/api/admin/users"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  it("returns the users list for an admin", async () => {
    setSession(adminSession);
    installDbMock();
    const { GET } = await import("@/app/api/admin/users/route");
    const res = await GET(new Request("http://localhost/api/admin/users"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users: Array<{ id: string; role: string; createdAt: string }>;
    };
    expect(body.users).toHaveLength(2);
    expect(body.users[0]?.id).toBe("admin-uuid");
    // Timestamps are serialized as ISO strings.
    expect(body.users[0]?.createdAt).toBe(fixedDate.toISOString());
  });
});

describe("PATCH /api/admin/users/[id]", () => {
  function makePatchReq(body: unknown) {
    return new Request("http://localhost/api/admin/users/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 403 when the session role is 'user'", async () => {
    setSession(userSession);
    installDbMock();
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const res = await PATCH(makePatchReq({ role: "admin" }), {
      params: Promise.resolve({ id: "any-uuid" }),
    });
    expect(res.status).toBe(403);
  });

  it("blocks self-demotion (admin demoting themselves)", async () => {
    setSession(adminSession);
    installDbMock();

    let setCalled = false;
    dbHooks.onUpdateSet = () => {
      setCalled = true;
    };

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const res = await PATCH(makePatchReq({ role: "user" }), {
      params: Promise.resolve({ id: adminSession.id }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cannot_demote_self");
    // The DB update path must not have been invoked.
    expect(setCalled).toBe(false);
  });

  it("allows admin to promote another user (returns updated row)", async () => {
    setSession(adminSession);
    installDbMock();

    const promoted = {
      id: "user-uuid",
      email: "user@example.com",
      displayName: "User",
      role: "admin" as const,
      createdAt: fixedDate,
      lastSeenAt: fixedDate,
    };
    dbHooks.updateReturning = [promoted];

    let setReceived: Record<string, unknown> | undefined;
    dbHooks.onUpdateSet = (set) => {
      setReceived = set;
    };

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const res = await PATCH(makePatchReq({ role: "admin" }), {
      params: Promise.resolve({ id: "user-uuid" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string; id: string } };
    expect(body.user.id).toBe("user-uuid");
    expect(body.user.role).toBe("admin");
    expect(setReceived).toEqual({ role: "admin" });
  });

  it("rejects an invalid role payload", async () => {
    setSession(adminSession);
    installDbMock();
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const res = await PATCH(makePatchReq({ role: "superuser" }), {
      params: Promise.resolve({ id: "user-uuid" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_role");
  });

  it("returns 404 when no user matches the id", async () => {
    setSession(adminSession);
    installDbMock();
    dbHooks.updateReturning = []; // simulate no row updated

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const res = await PATCH(makePatchReq({ role: "admin" }), {
      params: Promise.resolve({ id: "nonexistent" }),
    });
    expect(res.status).toBe(404);
  });
});
