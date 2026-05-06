import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
});

describe("generateInvitationToken", () => {
  it("returns 64-char lowercase hex (32 bytes)", async () => {
    const { generateInvitationToken } = await import("@/lib/invitations");
    const token = generateInvitationToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns distinct values across calls (uniqueness)", async () => {
    const { generateInvitationToken } = await import("@/lib/invitations");
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) {
      tokens.add(generateInvitationToken());
    }
    expect(tokens.size).toBe(50);
  });
});

describe("lookupInvitation classification", () => {
  function mockDb(rows: unknown[]) {
    vi.doMock("@ai-workspace/db", async () => {
      const actual =
        await vi.importActual<typeof import("@ai-workspace/db")>(
          "@ai-workspace/db",
        );
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "limit") {
              return () => Promise.resolve(rows);
            }
            return () => proxy;
          },
        },
      );
      return { ...actual, getDb: () => proxy as never };
    });
  }

  it("returns not_found when no row matches the token", async () => {
    mockDb([]);
    const { lookupInvitation } = await import("@/lib/invitations");
    const r = await lookupInvitation("whatever");
    expect(r.status).toBe("not_found");
    expect(r.invitation).toBeUndefined();
  });

  it("returns accepted when accepted_at is set", async () => {
    const inv = {
      id: "i1",
      email: "x@example.com",
      role: "user",
      token: "t",
      invitedBy: "admin-id",
      acceptedAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    };
    mockDb([inv]);
    const { lookupInvitation } = await import("@/lib/invitations");
    const r = await lookupInvitation("t");
    expect(r.status).toBe("accepted");
    expect(r.invitation?.id).toBe("i1");
  });

  it("returns expired when expires_at is in the past", async () => {
    const inv = {
      id: "i2",
      email: "x@example.com",
      role: "user",
      token: "t",
      invitedBy: "admin-id",
      acceptedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    };
    mockDb([inv]);
    const { lookupInvitation } = await import("@/lib/invitations");
    const r = await lookupInvitation("t");
    expect(r.status).toBe("expired");
  });

  it("returns valid for a live, unaccepted invitation", async () => {
    const inv = {
      id: "i3",
      email: "x@example.com",
      role: "admin",
      token: "t",
      invitedBy: "admin-id",
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
    };
    mockDb([inv]);
    const { lookupInvitation } = await import("@/lib/invitations");
    const r = await lookupInvitation("t");
    expect(r.status).toBe("valid");
    expect(r.invitation?.role).toBe("admin");
  });
});
