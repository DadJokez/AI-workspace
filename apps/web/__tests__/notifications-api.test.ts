import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const USER_ID = "00000000-0000-4000-8000-000000000001";

const session: SessionUser = {
  id: USER_ID,
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

let currentSession: SessionUser | null = session;
const libCalls: Array<{ fn: string; args: unknown[] }> = [];
let openResult: Record<string, unknown> | null = null;

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentSession,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return { ...actual, getDb: () => ({}) as never };
  });
  vi.doMock("@/lib/notifications", () => ({
    listNotifications: async (...args: unknown[]) => {
      libCalls.push({ fn: "listNotifications", args });
      return { notifications: [], unreadCount: 0 };
    },
    markNotificationsRead: async (...args: unknown[]) => {
      libCalls.push({ fn: "markNotificationsRead", args });
    },
    openNotification: async (...args: unknown[]) => {
      libCalls.push({ fn: "openNotification", args });
      return openResult;
    },
    buildDigest: async (...args: unknown[]) => {
      libCalls.push({ fn: "buildDigest", args });
      return { since: new Date(), completedRuns: [], failedRuns: [], newShares: [] };
    },
  }));
}

function patchReq(body: unknown) {
  return new Request("http://localhost/api/notifications", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  currentSession = session;
  libCalls.length = 0;
  openResult = null;
});

afterEach(() => {
  vi.resetModules();
});

describe("/api/notifications", () => {
  it("returns 401 without a session", async () => {
    currentSession = null;
    installMocks();

    const { GET } = await import("@/app/api/notifications/route");
    expect((await GET()).status).toBe(401);
    expect(libCalls).toHaveLength(0);
  });

  it("lists the caller's notifications only (caller id is the scope)", async () => {
    installMocks();

    const { GET } = await import("@/app/api/notifications/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(libCalls[0]).toMatchObject({ fn: "listNotifications" });
    expect(libCalls[0]!.args[1]).toBe(USER_ID);
  });

  it("marks selected ids read, scoped to the caller", async () => {
    installMocks();

    const { PATCH } = await import("@/app/api/notifications/route");
    const res = await PATCH(patchReq({ ids: ["n1", "n2"] }));

    expect(res.status).toBe(200);
    expect(libCalls[0]).toMatchObject({ fn: "markNotificationsRead" });
    expect(libCalls[0]!.args[1]).toBe(USER_ID);
    expect(libCalls[0]!.args[2]).toEqual(["n1", "n2"]);
  });

  it("rejects a body with neither ids nor all", async () => {
    installMocks();

    const { PATCH } = await import("@/app/api/notifications/route");
    const res = await PATCH(patchReq({ everything: true }));

    expect(res.status).toBe(400);
    expect(libCalls).toHaveLength(0);
  });
});

describe("POST /api/notifications/[id]/open", () => {
  it("returns 401 without a session", async () => {
    currentSession = null;
    installMocks();

    const { POST } = await import("@/app/api/notifications/[id]/open/route");
    const res = await POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "n1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404s when the notification is missing or belongs to someone else", async () => {
    installMocks();

    const { POST } = await import("@/app/api/notifications/[id]/open/route");
    const res = await POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "someone-elses" }),
    });

    expect(res.status).toBe(404);
    expect(libCalls[0]!.args[1]).toBe(USER_ID);
  });

  it("records the acceptance and returns the notification", async () => {
    openResult = { id: "n1", acceptedAt: "2026-07-06T00:00:00Z" };
    installMocks();

    const { POST } = await import("@/app/api/notifications/[id]/open/route");
    const res = await POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "n1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      notification: { id: "n1" },
    });
  });
});

describe("GET /api/notifications/digest", () => {
  it("returns 401 without a session", async () => {
    currentSession = null;
    installMocks();

    const { GET } = await import("@/app/api/notifications/digest/route");
    expect((await GET()).status).toBe(401);
  });

  it("builds the digest for the caller", async () => {
    installMocks();

    const { GET } = await import("@/app/api/notifications/digest/route");
    const res = await GET();

    expect(res.status).toBe(200);
    expect(libCalls[0]).toMatchObject({ fn: "buildDigest" });
    expect(libCalls[0]!.args[1]).toBe(USER_ID);
  });
});
