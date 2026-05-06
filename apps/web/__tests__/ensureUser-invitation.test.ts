import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Verifies that `ensureUser` honors a pending invitation: when a brand-new
 * user signs in whose email matches an unaccepted, unexpired invitation,
 * (a) the new users row is inserted with the invited role and (b) the
 * invitation row is stamped accepted_at.
 *
 * The drizzle proxy is wider than ensureUser.test.ts because we have to
 * distinguish `select(...).from(users)` from `select(...).from(invitations)`
 * and `update(invitations)` from anything else.
 */

afterEach(() => {
  vi.resetModules();
});

interface Probe {
  insertedUserValues?: Record<string, unknown>;
  invitationUpdateSet?: Record<string, unknown>;
  invitationUpdateWhereCalled: boolean;
}

function makeProxy(probe: Probe, opts: {
  pendingInvite: { id: string; role: "admin" | "user" } | null;
  existingUserCount: number;
}): unknown {
  // Track which table the current select chain is targeting.
  let currentTarget: "users" | "invitations" | "unknown" = "unknown";
  // Track whether the current chain is an UPDATE (vs SELECT/INSERT).
  let inUpdate = false;
  let updateTarget: "users" | "invitations" | "unknown" = "unknown";

  function tableNameFromArg(arg: unknown): typeof currentTarget {
    // Drizzle table objects expose Symbol-keyed metadata. The simplest cross-
    // version probe: stringify and match on the table name.
    const s = String(
      // biome-ignore lint/suspicious/noExplicitAny: probe-only
      (arg as any)?.[Symbol.for("drizzle:Name")] ??
        // biome-ignore lint/suspicious/noExplicitAny: probe-only
        (arg as any)?._?.name ??
        "",
    );
    if (s === "users") return "users";
    if (s === "invitations") return "invitations";
    return "unknown";
  }

  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "from") {
          return (table: unknown) => {
            currentTarget = tableNameFromArg(table);
            return proxy;
          };
        }
        if (prop === "insert") {
          inUpdate = false;
          return (table: unknown) => {
            currentTarget = tableNameFromArg(table);
            return proxy;
          };
        }
        if (prop === "update") {
          inUpdate = true;
          return (table: unknown) => {
            updateTarget = tableNameFromArg(table);
            return proxy;
          };
        }
        if (prop === "values") {
          return (v: Record<string, unknown>) => {
            if (currentTarget === "users") probe.insertedUserValues = v;
            return proxy;
          };
        }
        if (prop === "set") {
          return (v: Record<string, unknown>) => {
            if (inUpdate && updateTarget === "invitations") {
              probe.invitationUpdateSet = v;
            }
            return proxy;
          };
        }
        if (prop === "where") {
          return () => {
            if (inUpdate && updateTarget === "invitations") {
              probe.invitationUpdateWhereCalled = true;
            }
            return proxy;
          };
        }
        if (prop === "limit") {
          return () => {
            // Two `select(...).limit(1)` paths matter:
            //   - existing user lookup (target=users) → return []
            //   - pending invitation lookup (target=invitations) → return invite (or [])
            if (currentTarget === "invitations") {
              return Promise.resolve(
                opts.pendingInvite ? [opts.pendingInvite] : [],
              );
            }
            return Promise.resolve([]);
          };
        }
        if (prop === "returning") {
          return () =>
            Promise.resolve([
              {
                id: "new-user-uuid",
                ...(probe.insertedUserValues ?? {}),
                createdAt: new Date(),
                lastSeenAt: new Date(),
                customInstructions: null,
              },
            ]);
        }
        if (prop === "then") {
          // `await db.select({count}).from(users)` resolves directly.
          return (resolve: (v: unknown) => void) =>
            resolve([{ count: opts.existingUserCount }]);
        }
        return () => proxy;
      },
    },
  );
  return proxy;
}

describe("ensureUser — invitation redemption", () => {
  it("applies the invited role and marks the invitation accepted", async () => {
    const probe: Probe = { invitationUpdateWhereCalled: false };

    vi.doMock("@ai-workspace/db", async () => {
      const actual =
        await vi.importActual<typeof import("@ai-workspace/db")>(
          "@ai-workspace/db",
        );
      const proxy = makeProxy(probe, {
        pendingInvite: { id: "invite-uuid", role: "admin" },
        existingUserCount: 5,
      });
      return {
        ...actual,
        getDb: () => proxy as never,
      };
    });

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-3",
      email: "invited@example.com",
      displayName: "Invited User",
    });

    expect(result.role).toBe("admin");
    expect(probe.insertedUserValues?.role).toBe("admin");
    expect(probe.insertedUserValues?.email).toBe("invited@example.com");
    expect(probe.invitationUpdateWhereCalled).toBe(true);
    expect(probe.invitationUpdateSet?.acceptedAt).toBeInstanceOf(Date);
  });

  it("falls back to default 'user' role when no invitation is pending", async () => {
    const probe: Probe = { invitationUpdateWhereCalled: false };

    vi.doMock("@ai-workspace/db", async () => {
      const actual =
        await vi.importActual<typeof import("@ai-workspace/db")>(
          "@ai-workspace/db",
        );
      const proxy = makeProxy(probe, {
        pendingInvite: null,
        existingUserCount: 5,
      });
      return {
        ...actual,
        getDb: () => proxy as never,
      };
    });

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-4",
      email: "uninvited@example.com",
      displayName: "Uninvited",
    });

    expect(result.role).toBe("user");
    expect(probe.invitationUpdateWhereCalled).toBe(false);
    expect(probe.invitationUpdateSet).toBeUndefined();
  });
});
