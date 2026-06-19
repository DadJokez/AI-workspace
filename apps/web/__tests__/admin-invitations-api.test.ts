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

const fixedDate = new Date("2026-06-20T00:00:00Z");
const futureDate = new Date("2026-07-01T00:00:00Z");

interface DbHooks {
  insertReturning?: Array<Record<string, unknown>>;
  selectRows?: Array<Record<string, unknown>>;
  onInsertValues?: (values: Record<string, unknown>) => void;
  insertedValues: Array<{ table: string; values: Record<string, unknown> }>;
  updates: Array<{ table: string; set: Record<string, unknown> }>;
}

let dbHooks: DbHooks;
let sendInvitationEmailMock: ReturnType<typeof vi.fn>;
let checkRateLimitMock: ReturnType<typeof vi.fn>;

function setSession(user: SessionUser | null) {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => user,
  }));
}

function installEmailMock() {
  class MockInvitationEmailError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  sendInvitationEmailMock = vi.fn(async () => ({
    provider: "ses" as const,
    messageId: "ses-message-1",
  }));
  vi.doMock("@/lib/invite-email", () => ({
    InvitationEmailError: MockInvitationEmailError,
    sendInvitationEmail: sendInvitationEmailMock,
  }));
}

function installRateLimitMock(allowed = true) {
  checkRateLimitMock = vi.fn(async () => ({
    allowed,
    limit: 20,
    remaining: allowed ? 19 : 0,
    resetAt: fixedDate,
    retryAfterSeconds: 60,
  }));
  vi.doMock("@/lib/request-limits", () => ({
    checkRateLimit: checkRateLimitMock,
  }));
}

function installDbMock() {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    let mode: "insert" | "update" | "select" | undefined;
    let currentTable = "unknown";
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "insert") {
            return (table: unknown) => {
              mode = "insert";
              currentTable = tableNameFromArg(table);
              return proxy;
            };
          }
          if (prop === "update") {
            return (table: unknown) => {
              mode = "update";
              currentTable = tableNameFromArg(table);
              return proxy;
            };
          }
          if (prop === "select") {
            return () => {
              mode = "select";
              currentTable = "unknown";
              return proxy;
            };
          }
          if (prop === "from") {
            return (table: unknown) => {
              currentTable = tableNameFromArg(table);
              return proxy;
            };
          }
          if (prop === "values") {
            return (values: Record<string, unknown>) => {
              dbHooks.insertedValues.push({ table: currentTable, values });
              if (mode === "insert" && currentTable === "invitations") {
                dbHooks.onInsertValues?.(values);
              }
              return proxy;
            };
          }
          if (prop === "set") {
            return (set: Record<string, unknown>) => {
              dbHooks.updates.push({ table: currentTable, set });
              return proxy;
            };
          }
          if (prop === "returning") {
            return () => Promise.resolve(dbHooks.insertReturning ?? []);
          }
          if (prop === "limit") {
            return () => Promise.resolve(dbHooks.selectRows ?? []);
          }
          if (prop === "orderBy" || prop === "where") {
            return () => proxy;
          }
          if (prop === "then") {
            return (resolve: (value: unknown) => void) => resolve([]);
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

function tableNameFromArg(arg: unknown): string {
  const maybeTable = arg as { _?: { name?: unknown } };
  const name = maybeTable._?.name ?? maybeTable[Symbol.for("drizzle:Name") as never];
  return typeof name === "string" ? name : "unknown";
}

function invitationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-uuid",
    email: "new@example.com",
    role: "user",
    token: "token-abc",
    acceptedAt: null,
    revokedAt: null,
    expiresAt: futureDate,
    emailStatus: "not_sent",
    emailSendAttempts: 0,
    lastEmailAttemptedAt: null,
    lastEmailSentAt: null,
    lastEmailError: null,
    lastEmailMessageId: null,
    createdAt: fixedDate,
    ...overrides,
  };
}

function makeReq(body: unknown) {
  return new Request("http://localhost/api/admin/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  dbHooks = { insertedValues: [], updates: [] };
  process.env.NEXTAUTH_URL = "https://example.com";
  installEmailMock();
  installRateLimitMock();
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/admin/invitations", () => {
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

  it("creates an invite, sends the email, records send state, and audits it", async () => {
    setSession(adminSession);
    installDbMock();

    let captured: Record<string, unknown> | undefined;
    dbHooks.onInsertValues = (values) => {
      captured = values;
      dbHooks.insertReturning = [
        invitationRecord({
          email: values.email,
          role: values.role,
          token: values.token,
          expiresAt: values.expiresAt,
        }),
      ];
    };

    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(
      makeReq({ email: "  NEW@Example.com  ", role: "user" }),
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      invitation: { status: string; inviteUrl: string; emailAttempts: number };
    };
    const token = captured?.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(captured?.email).toBe("new@example.com");
    expect(captured?.invitedBy).toBe("admin-uuid");
    expect(body.invitation.status).toBe("sent");
    expect(body.invitation.emailAttempts).toBe(1);
    expect(body.invitation.inviteUrl).toBe(
      `https://example.com/invite/${token}`,
    );
    expect(sendInvitationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "new@example.com",
        inviteUrl: `https://example.com/invite/${token}`,
        invitedByEmail: "admin@example.com",
      }),
    );
    expect(dbHooks.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "invitations",
          set: expect.objectContaining({ emailStatus: "sent" }),
        }),
      ]),
    );
    expect(dbHooks.insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "audit_log",
          values: expect.objectContaining({ actionType: "invite.create" }),
        }),
        expect.objectContaining({
          table: "audit_log",
          values: expect.objectContaining({ actionType: "invite.send" }),
        }),
      ]),
    );
  });

  it("keeps the invite retryable when the email provider fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sendInvitationEmailMock.mockRejectedValueOnce(new Error("provider down"));
    setSession(adminSession);
    installDbMock();
    dbHooks.onInsertValues = (values) => {
      dbHooks.insertReturning = [
        invitationRecord({
          email: values.email,
          role: values.role,
          token: values.token,
          expiresAt: values.expiresAt,
        }),
      ];
    };

    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makeReq({ email: "new@example.com", role: "user" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      warning?: string;
      invitation: { status: string; canResend: boolean };
    };
    expect(body.warning).toBe("email_send_failed");
    expect(body.invitation.status).toBe("failed");
    expect(body.invitation.canResend).toBe(true);
    expect(dbHooks.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "invitations",
          set: expect.objectContaining({
            emailStatus: "failed",
            lastEmailError: "email_send_failed",
          }),
        }),
      ]),
    );
  });

  it("rate limits invite sends before creating an invitation", async () => {
    installRateLimitMock(false);
    setSession(adminSession);
    installDbMock();
    const { POST } = await import("@/app/api/admin/invitations/route");
    const res = await POST(makeReq({ email: "new@example.com", role: "user" }));
    expect(res.status).toBe(429);
    expect(dbHooks.insertedValues).toEqual([]);
    expect(sendInvitationEmailMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/invitations", () => {
  it("returns 403 when the session role is 'user'", async () => {
    setSession(userSession);
    installDbMock();
    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns recent invitations with lifecycle status", async () => {
    setSession(adminSession);
    installDbMock();
    dbHooks.selectRows = [
      invitationRecord({
        id: "sent",
        emailStatus: "sent",
        lastEmailSentAt: fixedDate,
      }),
      invitationRecord({
        id: "accepted",
        acceptedAt: fixedDate,
        emailStatus: "sent",
      }),
      invitationRecord({
        id: "revoked",
        revokedAt: fixedDate,
        emailStatus: "sent",
      }),
      invitationRecord({
        id: "expired",
        expiresAt: new Date("2025-12-01T00:00:00Z"),
      }),
    ];

    const { GET } = await import("@/app/api/admin/invitations/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitations: Array<{ id: string; status: string; canResend: boolean }>;
    };
    expect(body.invitations.map((row) => [row.id, row.status])).toEqual([
      ["sent", "sent"],
      ["accepted", "accepted"],
      ["revoked", "revoked"],
      ["expired", "expired"],
    ]);
    expect(body.invitations.find((row) => row.id === "accepted")?.canResend)
      .toBe(false);
  });
});

describe("POST /api/admin/invitations/[id]/resend", () => {
  it("resends a still-valid invite using the existing token", async () => {
    setSession(adminSession);
    installDbMock();
    dbHooks.selectRows = [
      invitationRecord({
        id: "invite-1",
        token: "existing-token",
        emailStatus: "failed",
        emailSendAttempts: 1,
      }),
    ];

    const { POST } = await import(
      "@/app/api/admin/invitations/[id]/resend/route"
    );
    const res = await POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "invite-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitation: { status: string; emailAttempts: number };
    };
    expect(body.invitation.status).toBe("sent");
    expect(body.invitation.emailAttempts).toBe(2);
    expect(sendInvitationEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteUrl: "https://example.com/invite/existing-token",
      }),
    );
  });
});

describe("POST /api/admin/invitations/[id]/revoke", () => {
  it("revokes an unaccepted invite and returns the revoked state", async () => {
    setSession(adminSession);
    installDbMock();
    dbHooks.selectRows = [
      invitationRecord({
        id: "invite-1",
        emailStatus: "sent",
      }),
    ];

    const { POST } = await import(
      "@/app/api/admin/invitations/[id]/revoke/route"
    );
    const res = await POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "invite-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invitation: { status: string; canResend: boolean };
    };
    expect(body.invitation.status).toBe("revoked");
    expect(body.invitation.canResend).toBe(false);
    expect(dbHooks.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "invitations",
          set: expect.objectContaining({
            revokedBy: "admin-uuid",
            revokedAt: expect.any(Date),
          }),
        }),
      ]),
    );
  });
});
