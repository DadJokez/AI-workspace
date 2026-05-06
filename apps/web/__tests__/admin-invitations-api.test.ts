import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * Tests the admin invitations API. We mock the auth gate (`getSessionUser`)
 * and the invitations lib (`createInvitation` / `listPendingInvitations`)
 * directly, so we never touch a real DB. The route's role here is mostly
 * adapting requests/responses; the lib already has its own tests.
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

const fixedDate = new Date("2026-05-06T00:00:00Z");
const expiresDate = new Date("2026-05-13T00:00:00Z");

interface LibHooks {
  createInvitation?: ReturnType<typeof vi.fn>;
  listPendingInvitations?: ReturnType<typeof vi.fn>;
}

let libHooks: LibHooks = {};

function setSession(user: SessionUser | null) {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => user,
  }));
}

function installLibMock() {
  vi.doMock("@/lib/invitations", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/invitations")>(
        "@/lib/invitations",
      );
    return {
      ...actual,
      createInvitation:
        libHooks.createInvitation ??
        vi.fn(async (input: { email: string; role: "admin" | "user" }) => ({
          id: "inv-uuid",
          email: input.email.toLowerCase(),
          role: input.role,
          token: "tok_abc",
          invitedBy: adminSession.id,
          acceptedAt: null,
          expiresAt: expiresDate,
          createdAt: fixedDate,
        })),
      listPendingInvitations:
        libHooks.listPendingInvitations ?? vi.fn(async () => []),
    };
  });
}

beforeEach(() => {
  libHooks = {};
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  delete process.env.NEXTAUTH_URL;
  delete process.env.APP_BASE_URL;
});

describe("POST /api/admin/invitations", () => {
  function makePost(body: unknown) {
    return new Request("http://localhost/api/admin/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when there is no session", async () => {
    setSession(null);
    installLibMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makePost({ email: "x@y.com", role: "user" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the session role is 'user'", async () => {
    setSession(userSession);
    const created = vi.fn();
    libHooks.createInvitation = created;
    installLibMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makePost({ email: "x@y.com", role: "user" }));
    expect(res.status).toBe(403);
    expect(created).not.toHaveBeenCalled();
  });

  it("rejects an invalid email", async () => {
    setSession(adminSession);
    installLibMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makePost({ email: "not-an-email", role: "user" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_email");
  });

  it("rejects an invalid role", async () => {
    setSession(adminSession);
    installLibMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makePost({ email: "x@y.com", role: "owner" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_role");
  });

  it("creates an invitation and returns its URL when the admin posts a valid payload", async () => {
    process.env.NEXTAUTH_URL = "https://hub.example.com";
    setSession(adminSession);

    const created = vi.fn(
      async (input: {
        email: string;
        role: "admin" | "user";
        invitedBy: string;
      }) => ({
        id: "inv-uuid-1",
        email: input.email.toLowerCase(),
        role: input.role,
        token: "tok_xyz123",
        invitedBy: input.invitedBy,
        acceptedAt: null,
        expiresAt: expiresDate,
        createdAt: fixedDate,
      }),
    );
    libHooks.createInvitation = created;
    installLibMock();

    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makePost({ email: "Friend@Example.com", role: "admin" }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invitation: {
        id: string;
        email: string;
        role: string;
        token: string;
        inviteUrl: string;
      };
      inviteUrl: string;
    };
    expect(body.invitation.id).toBe("inv-uuid-1");
    expect(body.invitation.role).toBe("admin");
    expect(body.invitation.email).toBe("friend@example.com");
    expect(body.invitation.token).toBe("tok_xyz123");
    expect(body.inviteUrl).toBe(
      "https://hub.example.com/invite/tok_xyz123",
    );
    expect(created).toHaveBeenCalledWith({
      email: "Friend@Example.com",
      role: "admin",
      invitedBy: adminSession.id,
    });
  });
});

describe("GET /api/admin/invitations", () => {
  it("returns 403 for non-admin sessions", async () => {
    setSession(userSession);
    installLibMock();
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(new Request("http://localhost/api/admin/invitations"));
    expect(res.status).toBe(403);
  });

  it("returns the pending invitations list with derived URLs", async () => {
    process.env.NEXTAUTH_URL = "https://hub.example.com";
    setSession(adminSession);
    libHooks.listPendingInvitations = vi.fn(async () => [
      {
        id: "inv-1",
        email: "a@example.com",
        role: "user" as const,
        token: "tok_a",
        invitedByName: "Admin",
        invitedByEmail: "admin@example.com",
        createdAt: fixedDate,
        expiresAt: expiresDate,
      },
    ]);
    installLibMock();

    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET(
      new Request("http://localhost/api/admin/invitations"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitations: Array<{ id: string; inviteUrl: string }>;
    };
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]?.id).toBe("inv-1");
    expect(body.invitations[0]?.inviteUrl).toBe(
      "https://hub.example.com/invite/tok_a",
    );
  });
});
