import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * #136/specs/005 — onboarding writes on /api/user PATCH: assistant name and
 * role answers. Mirrors the admin-invitations test harness (mock auth + a
 * drizzle proxy) so we assert the written values without a database.
 */
const userSession: SessionUser = {
  id: "user-uuid",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

interface DbHooks {
  selectRows?: Array<Record<string, unknown>>;
  updateReturning?: Array<Record<string, unknown>>;
  onUpdateSet?: (values: Record<string, unknown>) => void;
  onInsertValues?: (values: Record<string, unknown>) => void;
  insertTable?: string;
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
              dbHooks.onInsertValues?.(v);
              return {
                onConflictDoNothing: () => Promise.resolve([]),
                returning: () => Promise.resolve(dbHooks.updateReturning ?? []),
              };
            };
          }
          if (prop === "set") {
            return (v: Record<string, unknown>) => {
              dbHooks.onUpdateSet?.(v);
              return proxy;
            };
          }
          if (prop === "returning") {
            return () => Promise.resolve(dbHooks.updateReturning ?? []);
          }
          if (prop === "limit") {
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
  vi.unstubAllGlobals();
});

function patch(body: unknown) {
  return new Request("http://localhost/api/user", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/user — onboarding", () => {
  it("saves a trimmed, capped assistant name", async () => {
    setSession(userSession);
    let setValues: Record<string, unknown> = {};
    dbHooks.onUpdateSet = (v) => (setValues = v);
    dbHooks.updateReturning = [
      {
        id: userSession.id,
        email: userSession.email,
        displayName: "User",
        role: "user",
        customInstructions: null,
        defaultModelId: null,
        assistantName: "Atlas",
        tourCompletedAt: null,
      },
    ];
    installDbMock();
    const { PATCH } = await import("@/app/api/user/route");
    const res = await PATCH(patch({ assistantName: "  Atlas  " }));
    expect(res?.status).toBe(200);
    expect(setValues.assistantName).toBe("Atlas");
  });

  it("seeds custom instructions + a role memory item from onboarding answers", async () => {
    setSession(userSession);
    let setValues: Record<string, unknown> = {};
    let insertValues: Record<string, unknown> = {};
    dbHooks.selectRows = [{ customInstructions: null }]; // user has none yet
    dbHooks.onUpdateSet = (v) => (setValues = v);
    dbHooks.onInsertValues = (v) => (insertValues = v);
    dbHooks.updateReturning = [
      {
        id: userSession.id,
        email: userSession.email,
        displayName: "User",
        role: "user",
        customInstructions: "My role: Engineering.",
        defaultModelId: null,
        assistantName: null,
        tourCompletedAt: null,
      },
    ];
    installDbMock();
    const { PATCH } = await import("@/app/api/user/route");
    const res = await PATCH(
      patch({
        onboarding: {
          role: "Engineering",
          tools: ["GitHub"],
          firstTask: "weekly status",
        },
      }),
    );
    expect(res?.status).toBe(200);
    expect(String(setValues.customInstructions)).toContain("Engineering");
    expect(insertValues.category).toBe("role");
    expect(insertValues.status).toBe("approved");
    expect(String(insertValues.bodyMd)).toContain("Engineering");
  });

  it("rejects a non-string assistant name", async () => {
    setSession(userSession);
    installDbMock();
    const { PATCH } = await import("@/app/api/user/route");
    const res = await PATCH(patch({ assistantName: 42 }));
    expect(res?.status).toBe(400);
  });
});
