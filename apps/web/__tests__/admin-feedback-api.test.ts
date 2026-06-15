import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const adminSession: SessionUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};

const userSession: SessionUser = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

const REPORT_ID = "00000000-0000-4000-8000-000000000099";
const fixedDate = new Date("2026-06-15T12:00:00.000Z");

let currentSession: SessionUser | null = adminSession;
let updateReturning: Array<Record<string, unknown>> = [];
let capturedPatch: Record<string, unknown> | undefined;

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentSession,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    const updateQuery: Record<string, unknown> = {};
    updateQuery.set = (patch: Record<string, unknown>) => {
      capturedPatch = patch;
      return updateQuery;
    };
    updateQuery.where = () => updateQuery;
    updateQuery.returning = () => Promise.resolve(updateReturning);

    return {
      ...actual,
      getDb: () =>
        ({
          update: () => updateQuery,
        }) as never,
    };
  });
}

function makeReq(body: unknown) {
  return new Request(`http://localhost/api/admin/feedback/${REPORT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  currentSession = adminSession;
  capturedPatch = undefined;
  updateReturning = [
    {
      id: REPORT_ID,
      status: "reviewing",
      adminNotes: "Can reproduce.",
      linkedIssueUrl: "https://github.com/example/repo/issues/1",
      resolvedAt: null,
      updatedAt: fixedDate,
    },
  ];
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("PATCH /api/admin/feedback/[id]", () => {
  it("returns 403 for non-admin users", async () => {
    currentSession = userSession;
    installMocks();

    const { PATCH } = await import("@/app/api/admin/feedback/[id]/route");
    const res = await PATCH(makeReq({ status: "reviewing" }), {
      params: Promise.resolve({ id: REPORT_ID }),
    });

    expect(res.status).toBe(403);
  });

  it("rejects unknown statuses", async () => {
    installMocks();

    const { PATCH } = await import("@/app/api/admin/feedback/[id]/route");
    const res = await PATCH(makeReq({ status: "done-ish" }), {
      params: Promise.resolve({ id: REPORT_ID }),
    });

    expect(res.status).toBe(400);
    expect(capturedPatch).toBeUndefined();
  });

  it("updates report triage fields", async () => {
    installMocks();

    const { PATCH } = await import("@/app/api/admin/feedback/[id]/route");
    const res = await PATCH(
      makeReq({
        status: "reviewing",
        adminNotes: "Can reproduce.",
        linkedIssueUrl: "https://github.com/example/repo/issues/1",
      }),
      { params: Promise.resolve({ id: REPORT_ID }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      report: {
        id: REPORT_ID,
        status: "reviewing",
        adminNotes: "Can reproduce.",
      },
    });
    expect(capturedPatch).toMatchObject({
      status: "reviewing",
      adminNotes: "Can reproduce.",
      linkedIssueUrl: "https://github.com/example/repo/issues/1",
    });
  });
});
