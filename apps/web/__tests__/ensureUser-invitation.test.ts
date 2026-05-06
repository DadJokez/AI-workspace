import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `ensureUser` redeems a matching invitation when creating a new user. We
 * mock `@/lib/invitations` so this stays a unit test that doesn't touch the
 * DB; the drizzle proxy below is the same shape the other ensureUser tests
 * use.
 */

afterEach(() => {
  vi.resetModules();
});

interface InvitationStub {
  id: string;
  email: string;
  role: "admin" | "user";
  token: string;
  invitedBy: string;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

function installMocks(opts: {
  invitation?: InvitationStub;
  existingUserCount: number;
  onMarkAccepted?: (id: string) => void;
}) {
  vi.doMock("@/lib/invitations", () => ({
    findPendingInvitationForEmail: async () => opts.invitation,
    markInvitationAccepted: async (id: string) => {
      opts.onMarkAccepted?.(id);
    },
  }));

  const insertedRows: Array<Record<string, unknown>> = [];

  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    let capturedInsertValues: Record<string, unknown> | undefined;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "limit") {
            return () => Promise.resolve([]); // no existing pingSubject row
          }
          if (prop === "values") {
            return (v: Record<string, unknown>) => {
              capturedInsertValues = v;
              return proxy;
            };
          }
          if (prop === "returning") {
            const inserted = {
              id: "new-user-uuid",
              ...capturedInsertValues,
              createdAt: new Date(),
              lastSeenAt: new Date(),
              customInstructions: null,
            };
            insertedRows.push(inserted);
            return () => Promise.resolve([inserted]);
          }
          if (prop === "then") {
            return (resolve: (v: unknown) => void) =>
              resolve([{ count: opts.existingUserCount }]);
          }
          return () => proxy;
        },
      },
    );

    return { ...actual, getDb: () => proxy as never };
  });

  return { insertedRows };
}

describe("ensureUser — invitation redemption", () => {
  it("uses the invitation's role when creating a new user", async () => {
    const markedIds: string[] = [];
    const { insertedRows } = installMocks({
      invitation: {
        id: "invite-1",
        email: "invited@example.com",
        role: "admin",
        token: "tok",
        invitedBy: "admin-uuid",
        acceptedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      },
      existingUserCount: 5, // not first user; default would be "user"
      onMarkAccepted: (id) => markedIds.push(id),
    });

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-invited",
      email: "invited@example.com",
      displayName: "Invited",
    });

    expect(result.role).toBe("admin");
    expect(insertedRows[0]?.role).toBe("admin");
    expect(markedIds).toEqual(["invite-1"]);
  });

  it("invitation overrides the first-user-admin default to 'user'", async () => {
    const markedIds: string[] = [];
    const { insertedRows } = installMocks({
      invitation: {
        id: "invite-2",
        email: "first@example.com",
        role: "user",
        token: "tok",
        invitedBy: "admin-uuid",
        acceptedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      },
      existingUserCount: 0, // would otherwise become admin
      onMarkAccepted: (id) => markedIds.push(id),
    });

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-first",
      email: "first@example.com",
      displayName: "First",
    });

    expect(result.role).toBe("user");
    expect(insertedRows[0]?.role).toBe("user");
    expect(markedIds).toEqual(["invite-2"]);
  });

  it("falls through to the default role when there's no invitation", async () => {
    const markedIds: string[] = [];
    const { insertedRows } = installMocks({
      invitation: undefined,
      existingUserCount: 5,
      onMarkAccepted: (id) => markedIds.push(id),
    });

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-none",
      email: "no-invite@example.com",
      displayName: "Nobody",
    });

    expect(result.role).toBe("user");
    expect(insertedRows[0]?.role).toBe("user");
    expect(markedIds).toEqual([]);
  });
});
