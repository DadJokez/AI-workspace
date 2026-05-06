import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * Tests for the admin invitations API. Mocks `getSessionUser` (auth gate) and
 * `@ai-workspace/db` (so the route can call into Drizzle without a real DB).
 * The mock proxy is identical in shape to the one used by admin-users-api.test
 * — terminal chain methods (`returning`, `orderBy`) resolve to canned data.
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
const futureExpiry = new Date("2026-01-08T00:00:00Z");

function setSession(user: SessionUser | null) {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => user,
  }));
}

interface DbHooks {
  insertReturning?: () => Array<Record<string, unknown>>;
  selectRows?: Array<Record<string, unknown>>;
  onInsertValues?: (v: Record<string, unknown>) => void;
}

let dbHooks: DbHooks = {};

function installDbMock() {
  vi.doMock("@ai-workspace/db", async () => {
    const actual = await vi.importActual<typeof import("@ai-workspace/db")>(
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
            return () => Promise.resolve(dbHooks.insertReturning?.() ?? []);
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
});

afterEach(() => {
  vi.resetModules();
});

function makePostReq(body: unknown) {
  return new Request("http://localhost/api/admin/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/invitations — auth gate", () => {
  it("returns 401 when there is no session", async () => {
    setSession(null);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makePostReq({ email: "x@y.com", role: "user" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when session role is 'user'", async () => {
    setSession(userSession);
    installDbMock();
    let inserted = false;
    dbHooks.onInsertValues = () => {
      inserted = true;
    };
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makePostReq({ email: "x@y.com", role: "user" }));
    expect(res.status).toBe(403);
    expect(inserted).toBe(false);
  });
});

describe("POST /api/admin/invitations — validation", () => {
  it("rejects malformed JSON", async () => {
    setSession(adminSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      new Request("http://localhost/api/admin/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("rejects an obviously-broken email", async () => {
    setSession(adminSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makePostReq({ email: "not-an-email", role: "user" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_email");
  });

  it("rejects an unknown role value", async () => {
    setSession(adminSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makePostReq({ email: "ok@example.com", role: "superuser" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_role");
  });
});

describe("POST /api/admin/invitations — happy path + token uniqueness", () => {
  it("returns 201 with an invite URL and persists a normalized email", async () => {
    setSession(adminSession);
    installDbMock();

    let captured: Record<string, unknown> | undefined;
    dbHooks.onInsertValues = (v) => {
      captured = v;
    };
    dbHooks.insertReturning = () => [
      {
        id: "inv-uuid",
        email: captured?.email ?? "",
        role: captured?.role ?? "user",
        invitedBy: captured?.invitedBy ?? "",
        token: captured?.token ?? "",
        expiresAt: futureExpiry,
        createdAt: fixedDate,
      },
    ];

    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makePostReq({ email: "  Mixed.Case@Example.COM ", role: "admin" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      inviteUrl: string;
      invitation: { email: string; role: string; inviteUrl: string };
    };
    expect(body.invitation.email).toBe("mixed.case@example.com");
    expect(body.invitation.role).toBe("admin");
    expect(body.inviteUrl).toMatch(/\/invite\/[a-f0-9]{64}$/);
    expect(body.inviteUrl).toBe(body.invitation.inviteUrl);
    expect(captured?.invitedBy).toBe(adminSession.id);
    expect(typeof captured?.token).toBe("string");
    // randomBytes(32).toString("hex") = 64 hex chars
    expect((captured?.token as string).length).toBe(64);
  });

  it("generates a different token on each call (uniqueness)", async () => {
    setSession(adminSession);
    installDbMock();

    const tokens: string[] = [];
    dbHooks.onInsertValues = (v) => {
      tokens.push(v.token as string);
    };
    dbHooks.insertReturning = () => [
      {
        id: "inv-uuid",
        email: "x@y.com",
        role: "user",
        invitedBy: adminSession.id,
        token: tokens[tokens.length - 1] ?? "",
        expiresAt: futureExpiry,
        createdAt: fixedDate,
      },
    ];

    const { POST } = await import("@/app/api/admin/invitations/route");
    await POST(makePostReq({ email: "a@b.com", role: "user" }));
    await POST(makePostReq({ email: "c@d.com", role: "user" }));

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens[0]?.length).toBe(64);
    expect(tokens[1]?.length).toBe(64);
  });

  it("sets expires_at ~7 days in the future", async () => {
    setSession(adminSession);
    installDbMock();

    let captured: Record<string, unknown> | undefined;
    dbHooks.onInsertValues = (v) => {
      captured = v;
    };
    dbHooks.insertReturning = () => [
      {
        id: "inv-uuid",
        email: captured?.email ?? "",
        role: captured?.role ?? "user",
        invitedBy: adminSession.id,
        token: captured?.token ?? "",
        expiresAt: captured?.expiresAt as Date,
        createdAt: fixedDate,
      },
    ];

    const { POST } = await import("@/app/api/admin/invitations/route");
    const before = Date.now();
    const res = await POST(makePostReq({ email: "x@y.com", role: "user" }));
    expect(res.status).toBe(201);

    const expiresAt = (captured?.expiresAt as Date).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAt - before).toBeGreaterThanOrEqual(sevenDays - 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(sevenDays + 1000);
  });
});

describe("GET /api/admin/invitations — auth gate", () => {
  it("returns 401 when there is no session", async () => {
    setSession(null);
    installDbMock();
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(new Request("http://localhost/api/admin/invitations"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when session role is 'user'", async () => {
    setSession(userSession);
    installDbMock();
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(new Request("http://localhost/api/admin/invitations"));
    expect(res.status).toBe(403);
  });

  it("returns the pending invitations for an admin", async () => {
    setSession(adminSession);
    installDbMock();
    dbHooks.selectRows = [
      {
        id: "inv-1",
        email: "alice@example.com",
        role: "user" as const,
        token: "a".repeat(64),
        invitedBy: adminSession.id,
        invitedByEmail: adminSession.email,
        expiresAt: futureExpiry,
        createdAt: fixedDate,
      },
    ];
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(new Request("http://localhost/api/admin/invitations"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitations: Array<{ email: string; inviteUrl: string }>;
    };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]?.email).toBe("alice@example.com");
    expect(body.invitations[0]?.inviteUrl).toMatch(/\/invite\/a{64}$/);
  });
});
