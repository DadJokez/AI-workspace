import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const sessionUser: SessionUser = {
  id: "user-uuid",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

type UserRow = {
  id: string;
  pingSubject: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  customInstructions: string | null;
  defaultModelId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
};

const baseRow: UserRow = {
  id: "user-uuid",
  pingSubject: "github-123",
  email: "user@example.com",
  displayName: "User",
  role: "user" as const,
  customInstructions: null,
  defaultModelId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastSeenAt: new Date("2026-01-01T00:00:00Z"),
};

interface DbHooks {
  selectRows?: UserRow[];
  updateReturning?: UserRow[];
  onUpdateSet?: (set: Record<string, unknown>) => void;
}

let dbHooks: DbHooks = {};

function makeReq(body: unknown) {
  return new Request("http://localhost/api/user", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => sessionUser,
  }));

  // #300: the route rejects defaults that aren't chat-enabled in the registry.
  vi.doMock("@/lib/model-registry", () => ({
    isModelEnabled: async (_db: unknown, id: string) =>
      ["haiku-4-5", "sonnet-4-5", "sonnet-4-6", "opus-4-7"].includes(id),
  }));

  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "limit") {
            return () => Promise.resolve(dbHooks.selectRows ?? [baseRow]);
          }
          if (prop === "set") {
            return (set: Record<string, unknown>) => {
              dbHooks.onUpdateSet?.(set);
              return proxy;
            };
          }
          if (prop === "returning") {
            return () =>
              Promise.resolve(
                dbHooks.updateReturning ?? [
                  { ...baseRow, defaultModelId: "default" },
                ],
              );
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

describe("/api/user", () => {
  it("returns the account-level default model", async () => {
    installMocks();
    dbHooks.selectRows = [{ ...baseRow, defaultModelId: "default" }];

    const { GET } = await import("@/app/api/user/route");
    const res = (await GET())!;

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { defaultModelId: string | null };
    };
    expect(body.user.defaultModelId).toBe("default");
  });

  it("persists default model changes", async () => {
    installMocks();
    let setReceived: Record<string, unknown> | undefined;
    dbHooks.onUpdateSet = (set) => {
      setReceived = set;
    };
    dbHooks.updateReturning = [{ ...baseRow, defaultModelId: "haiku-4-5" }];

    const { PATCH } = await import("@/app/api/user/route");
    const res = (await PATCH(makeReq({ defaultModelId: "haiku-4-5" })))!;

    expect(res.status).toBe(200);
    expect(setReceived).toEqual({ defaultModelId: "haiku-4-5" });
    const body = (await res.json()) as {
      user: { defaultModelId: string | null };
    };
    expect(body.user.defaultModelId).toBe("haiku-4-5");
  });

  it("rejects a default model the registry has not enabled (#300)", async () => {
    installMocks();
    let setReceived: Record<string, unknown> | undefined;
    dbHooks.onUpdateSet = (set) => {
      setReceived = set;
    };

    const { PATCH } = await import("@/app/api/user/route");
    const res = (await PATCH(makeReq({ defaultModelId: "gpt-junk" })))!;

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "invalid_defaultModelId",
    });
    expect(setReceived).toBeUndefined();
  });

  it("clears blank default model ids", async () => {
    installMocks();
    let setReceived: Record<string, unknown> | undefined;
    dbHooks.onUpdateSet = (set) => {
      setReceived = set;
    };
    dbHooks.updateReturning = [{ ...baseRow, defaultModelId: null }];

    const { PATCH } = await import("@/app/api/user/route");
    const res = (await PATCH(makeReq({ defaultModelId: "   " })))!;

    expect(res.status).toBe(200);
    expect(setReceived).toEqual({ defaultModelId: null });
  });
});
