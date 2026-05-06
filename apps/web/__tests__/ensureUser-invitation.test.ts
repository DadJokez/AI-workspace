import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Verifies that `ensureUser` consults `consumePendingInvitationForEmail`
 * before falling back to first-user-becomes-admin / `user`. We mock both
 * the invitations lib and `@ai-workspace/db`'s `getDb` so the test stays
 * driverless.
 */

afterEach(() => {
  vi.resetModules();
});

function installDbMock(opts: { existingCount: number }) {
  const insertedRows: Array<Record<string, unknown>> = [];
  vi.doMock("@ai-workspace/db", async () => {
    const actual = await vi.importActual<
      typeof import("@ai-workspace/db")
    >("@ai-workspace/db");
    let captured: Record<string, unknown> | undefined;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "limit") return () => Promise.resolve([]);
          if (prop === "values")
            return (v: Record<string, unknown>) => {
              captured = v;
              return proxy;
            };
          if (prop === "returning") {
            const inserted = {
              id: "new-uuid",
              ...captured,
              createdAt: new Date(),
              lastSeenAt: new Date(),
              customInstructions: null,
            };
            insertedRows.push(inserted);
            return () => Promise.resolve([inserted]);
          }
          if (prop === "then") {
            return (resolve: (v: unknown) => void) =>
              resolve([{ count: opts.existingCount }]);
          }
          return () => proxy;
        },
      },
    );
    return { ...actual, getDb: () => proxy as never };
  });
  return { insertedRows };
}

describe("ensureUser — invitation consumption", () => {
  it("assigns the role from a matching pending invitation", async () => {
    const consume = vi.fn(async () => "admin" as const);
    vi.doMock("@/lib/invitations", () => ({
      consumePendingInvitationForEmail: consume,
    }));

    // Simulate a workspace that already has 5 users, so the default role
    // would be "user" — we want the invitation to override that to admin.
    const { insertedRows } = installDbMock({ existingCount: 5 });

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-x",
      email: "invited@example.com",
      displayName: "Invited",
    });

    expect(consume).toHaveBeenCalledWith("invited@example.com");
    expect(result.role).toBe("admin");
    expect(insertedRows[0]?.role).toBe("admin");
  });

  it("falls back to default role when no invitation matches", async () => {
    const consume = vi.fn(async () => null);
    vi.doMock("@/lib/invitations", () => ({
      consumePendingInvitationForEmail: consume,
    }));

    const { insertedRows } = installDbMock({ existingCount: 5 });

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-y",
      email: "uninvited@example.com",
      displayName: "Uninvited",
    });

    expect(consume).toHaveBeenCalledWith("uninvited@example.com");
    expect(result.role).toBe("user");
    expect(insertedRows[0]?.role).toBe("user");
  });

  it("first-user-becomes-admin still wins when there is no invite and the table is empty", async () => {
    vi.doMock("@/lib/invitations", () => ({
      consumePendingInvitationForEmail: vi.fn(async () => null),
    }));

    const { insertedRows } = installDbMock({ existingCount: 0 });

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-z",
      email: "first@example.com",
      displayName: "First",
    });

    expect(result.role).toBe("admin");
    expect(insertedRows[0]?.role).toBe("admin");
  });
});
