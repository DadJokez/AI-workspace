import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

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
const futureDate = new Date("2026-01-08T00:00:00Z");

interface DbHooks {
  insertCaptured?: Record<string, unknown>;
  insertReturning?: Record<string, unknown>[];
  selectRows?: Record<string, unknown>[];
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
              dbHooks.insertCaptured = v;
              return proxy;
            };
          }
          if (prop === "returning") {
            const captured = dbHooks.insertCaptured ?? {};
            const fallback = [
              {
                id: "inv-uuid",
                email: captured.email ?? "x@example.com",
                role: captured.role ?? "user",
                token: captured.token ?? "tok",
                invitedBy: captured.invitedBy ?? adminSession.id,
                acceptedAt: null,
                expiresAt: captured.expiresAt ?? futureDate,
                createdAt: fixedDate,
              },
            ];
            return () => Promise.resolve(dbHooks.insertReturning ?? fallback);
          }
          if (prop === "orderBy") {
            return () => Promise.resolve(dbHooks.selectRows ?? []);
          }
          return () => proxy;
        },
      },
    );

    return { ...actual, getDb: () => proxy as never };
  });
}

beforeEach(() => {
  dbHooks = {};
});

afterEach(() => {
  vi.resetModules();
});

describe("POST /api/admin/invitations", () => {
  function makeReq(body: unknown) {
    return new Request("http://localhost/api/admin/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when there is no session", async () => {
    setSession(null);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makeReq({ email: "x@example.com", role: "user" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the session role is 'user' (non-admin blocked)", async () => {
    setSession(userSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makeReq({ email: "x@example.com", role: "user" }),
    );
    expect(res.status).toBe(403);
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

  it("rejects an invalid role", async () => {
    setSession(adminSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makeReq({ email: "x@example.com", role: "superuser" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_role");
  });

  it("creates an invitation and returns inviteUrl + invitation row", async () => {
    setSession(adminSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makeReq({ email: "new@example.com", role: "admin" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitation: {
        id: string;
        email: string;
        role: string;
        expiresAt: string;
      };
      inviteUrl: string;
    };
    expect(body.invitation.email).toBe("new@example.com");
    expect(body.invitation.role).toBe("admin");
    // The captured insert payload must carry the bound admin id and a hex token.
    expect(dbHooks.insertCaptured?.invitedBy).toBe(adminSession.id);
    expect(dbHooks.insertCaptured?.email).toBe("new@example.com");
    expect(dbHooks.insertCaptured?.role).toBe("admin");
    expect(typeof dbHooks.insertCaptured?.token).toBe("string");
    expect(dbHooks.insertCaptured?.token as string).toMatch(/^[0-9a-f]{64}$/);
    // Invite URL points at /invite/<token> on the request origin.
    expect(body.inviteUrl).toContain("/invite/");
    expect(body.inviteUrl.endsWith(dbHooks.insertCaptured!.token as string))
      .toBe(true);
  });

  it("each invitation gets a unique token (call twice, expect different tokens)", async () => {
    setSession(adminSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");

    const r1 = await POST(makeReq({ email: "a@example.com", role: "user" }));
    expect(r1.status).toBe(200);
    const t1 = dbHooks.insertCaptured!.token as string;

    const r2 = await POST(makeReq({ email: "b@example.com", role: "user" }));
    expect(r2.status).toBe(200);
    const t2 = dbHooks.insertCaptured!.token as string;

    expect(t1).not.toBe(t2);
  });
});

describe("GET /api/admin/invitations", () => {
  it("returns 401 with no session", async () => {
    setSession(null);
    installDbMock();
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(new Request("http://localhost/api/admin/invitations"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the session role is 'user'", async () => {
    setSession(userSession);
    installDbMock();
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(new Request("http://localhost/api/admin/invitations"));
    expect(res.status).toBe(403);
  });

  it("returns the pending invitations for an admin", async () => {
    setSession(adminSession);
    dbHooks.selectRows = [
      {
        id: "i1",
        email: "pending@example.com",
        role: "user" as const,
        expiresAt: futureDate,
        createdAt: fixedDate,
        invitedByEmail: adminSession.email,
      },
    ];
    installDbMock();
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(
      new Request("http://localhost/api/admin/invitations"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitations: Array<{
        id: string;
        email: string;
        role: string;
        expiresAt: string;
        invitedByEmail: string;
      }>;
    };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]?.email).toBe("pending@example.com");
    expect(body.invitations[0]?.expiresAt).toBe(futureDate.toISOString());
    expect(body.invitations[0]?.invitedByEmail).toBe(adminSession.email);
  });
});
