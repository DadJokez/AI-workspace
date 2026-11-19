import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * POST /api/admin/users/[id]/status (WP-18): the admin gate, the action and
 * id checks, and how lifecycle results map to responses. The lifecycle
 * itself is covered in user-lifecycle.test.ts and against real Postgres.
 */

const TARGET = "00000000-0000-4000-8000-0000000000aa";

const admin: SessionUser = {
  id: "admin-uuid",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};

let currentUser: SessionUser | null;
const lifecycle = {
  suspendUser: vi.fn(),
  deprovisionUser: vi.fn(),
  reactivateUser: vi.fn(),
};

function load() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentUser,
  }));
  vi.doMock("@/lib/user-lifecycle", async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/user-lifecycle")
    >("@/lib/user-lifecycle");
    return { ...actual, ...lifecycle };
  });
  return import("@/app/api/admin/users/[id]/status/route");
}

function post(body: unknown, id = TARGET) {
  return [
    new Request(`http://localhost/api/admin/users/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => {
  currentUser = admin;
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("POST /api/admin/users/[id]/status", () => {
  it("is admin only", async () => {
    currentUser = { ...admin, role: "user" };
    const { POST } = await load();
    const res = await POST(...post({ action: "suspend", reason: "x" }));
    expect(res.status).toBe(403);
    expect(lifecycle.suspendUser).not.toHaveBeenCalled();
  });

  it("rejects an unknown action and a malformed id without calling the lifecycle", async () => {
    const { POST } = await load();
    expect(
      (await POST(...post({ action: "delete", reason: "x" }))).status,
    ).toBe(400);
    expect(
      (await POST(...post({ action: "toString", reason: "x" }))).status,
    ).toBe(400);
    expect(
      (await POST(...post({ action: "suspend", reason: "x" }, "not-a-uuid")))
        .status,
    ).toBe(404);
    expect(lifecycle.suspendUser).not.toHaveBeenCalled();
  });

  it.each([
    ["suspend", "suspendUser"],
    ["deprovision", "deprovisionUser"],
    ["reactivate", "reactivateUser"],
  ] as const)(
    "%s calls %s as the session admin and returns the new status",
    async (action, fn) => {
      const changedAt = new Date("2026-11-19T10:00:00.000Z");
      lifecycle[fn].mockResolvedValue({
        ok: true,
        user: {
          id: TARGET,
          status: action === "reactivate" ? "active" : `${action}ed`,
          statusChangedAt: changedAt,
          statusReason: "Because",
        },
        effects: { sessionVersion: 1 },
      });
      const { POST } = await load();

      const res = await POST(...post({ action, reason: "Because" }));

      expect(res.status).toBe(200);
      expect(lifecycle[fn]).toHaveBeenCalledWith(TARGET, admin, "Because");
      expect(await res.json()).toMatchObject({
        user: { id: TARGET, statusChangedAt: changedAt.toISOString() },
      });
    },
  );

  it("maps a refusal to its status with a readable message", async () => {
    lifecycle.suspendUser.mockResolvedValue({
      ok: false,
      status: 409,
      error: "last_admin",
    });
    const { POST } = await load();

    const res = await POST(...post({ action: "suspend", reason: "x" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "last_admin",
      message: "This is the last active admin. Make someone else an admin first.",
    });
  });
});
