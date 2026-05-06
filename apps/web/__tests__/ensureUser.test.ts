import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for `ensureUser` against a fake drizzle (Proxy). Terminal
 * methods on the chain (`.limit`, `.returning`, the implicit `await` on a
 * count select) resolve to canned data; everything else returns the proxy so
 * the chain keeps composing.
 *
 * Two paths are exercised here:
 *   - First-signup-becomes-admin (no invitation in the table).
 *   - Invitation-consumes (pending invitation matches the new user's email).
 */

afterEach(() => {
  vi.resetModules();
});

describe("ensureUser — first-signup-becomes-admin", () => {
  it("assigns role=admin when the users table is empty", async () => {
    const insertedRows: Array<Record<string, unknown>> = [];

    vi.doMock("@ai-workspace/db", async () => {
      const actual = await vi.importActual<
        typeof import("@ai-workspace/db")
      >("@ai-workspace/db");

      let capturedInsertValues: Record<string, unknown> | undefined;
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "limit") {
              return () => Promise.resolve([]); // no existing user
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
              // `await db.select({count}).from(users)` — return count=0
              return (resolve: (v: unknown) => void) =>
                resolve([{ count: 0 }]);
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

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-1",
      email: "first@example.com",
      displayName: "First User",
    });

    expect(result.role).toBe("admin");
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.role).toBe("admin");
    expect(insertedRows[0]?.pingSubject).toBe("ping-sub-1");
  });

  it("assigns role=user when other users already exist", async () => {
    const insertedRows: Array<Record<string, unknown>> = [];

    vi.doMock("@ai-workspace/db", async () => {
      const actual = await vi.importActual<
        typeof import("@ai-workspace/db")
      >("@ai-workspace/db");

      let capturedInsertValues: Record<string, unknown> | undefined;
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "limit") {
              return () => Promise.resolve([]);
            }
            if (prop === "values") {
              return (v: Record<string, unknown>) => {
                capturedInsertValues = v;
                return proxy;
              };
            }
            if (prop === "returning") {
              const inserted = {
                id: "another-user-uuid",
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
                resolve([{ count: 5 }]); // five existing users
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

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-2",
      email: "second@example.com",
      displayName: "Second User",
    });

    expect(result.role).toBe("user");
    expect(insertedRows[0]?.role).toBe("user");
  });
});

describe("ensureUser — invitation consumption", () => {
  it("uses the invitation's role and stamps accepted_at on first sign-in", async () => {
    /**
     * Mock that distinguishes the two `.limit(1)` calls in `ensureUser`:
     *   - 1st `.limit(1)` is the existing-user lookup → []
     *   - 2nd `.limit(1)` is the pending-invitation lookup → match
     * We track call order with a counter rather than the table reference so
     * the test stays decoupled from how Drizzle introspects table objects.
     */
    let limitCalls = 0;
    const updateSets: Array<Record<string, unknown>> = [];
    const insertedRows: Array<Record<string, unknown>> = [];

    vi.doMock("@ai-workspace/db", async () => {
      const actual = await vi.importActual<
        typeof import("@ai-workspace/db")
      >("@ai-workspace/db");

      let capturedInsertValues: Record<string, unknown> | undefined;
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "limit") {
              return () => {
                limitCalls += 1;
                if (limitCalls === 1) return Promise.resolve([]); // no user yet
                if (limitCalls === 2)
                  return Promise.resolve([
                    { id: "inv-uuid", role: "admin" as const },
                  ]);
                return Promise.resolve([]);
              };
            }
            if (prop === "values") {
              return (v: Record<string, unknown>) => {
                capturedInsertValues = v;
                return proxy;
              };
            }
            if (prop === "set") {
              return (v: Record<string, unknown>) => {
                updateSets.push(v);
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
              // Triggered when `await db.update(invitations).set().where()`
              // resolves. The count-select branch is unreachable here because
              // the invitation lookup short-circuits the role decision.
              return (resolve: (v: unknown) => void) => resolve(undefined);
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

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-3",
      email: "Invited@Example.com",
      displayName: "Invited User",
    });

    // Invitation said role=admin → new user gets role=admin even if other
    // users exist (the first-user-becomes-admin fallback isn't consulted).
    expect(result.role).toBe("admin");
    expect(insertedRows[0]?.role).toBe("admin");
    // The invitation row was marked accepted (one update with accepted_at).
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toHaveProperty("acceptedAt");
    expect(updateSets[0]?.acceptedAt).toBeInstanceOf(Date);
  });

  it("falls back to first-user-becomes-admin when no invitation matches", async () => {
    // Sanity check on the precedence in the comment in users.ts: when the
    // invitation lookup returns no rows, `decideInitialRole` runs as before.
    let limitCalls = 0;
    const insertedRows: Array<Record<string, unknown>> = [];

    vi.doMock("@ai-workspace/db", async () => {
      const actual = await vi.importActual<
        typeof import("@ai-workspace/db")
      >("@ai-workspace/db");

      let capturedInsertValues: Record<string, unknown> | undefined;
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "limit") {
              return () => {
                limitCalls += 1;
                return Promise.resolve([]); // both lookups empty
              };
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
              // Count-select: 3 existing users, so role should be 'user'.
              return (resolve: (v: unknown) => void) =>
                resolve([{ count: 3 }]);
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

    const { ensureUser } = await import("@/lib/users");
    const result = await ensureUser({
      id: "ping-sub-4",
      email: "noinvite@example.com",
      displayName: "Walk-in",
    });

    expect(limitCalls).toBe(2); // user lookup + invitation lookup
    expect(result.role).toBe("user");
    expect(insertedRows[0]?.role).toBe("user");
  });
});
