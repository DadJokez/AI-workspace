import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Integration test for `ensureUser` — verifies the first-signup-becomes-admin
 * path against a fake drizzle that's just a Proxy. Terminal methods on the
 * chain (`.limit`, `.returning`, the implicit `await` on a count select)
 * resolve to canned data; everything else returns the proxy so the chain
 * keeps composing.
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
