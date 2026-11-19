import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";
import {
  auditLog,
  eventTriggers,
  oauthTokens,
  runs,
  schedules,
  users,
  type Database,
} from "@ai-workspace/db";

/**
 * WP-18 lifecycle functions against a fake transaction and a fake clock. The
 * same flows against real Postgres (the bumped version refusing a live JWT,
 * the worker and scheduler skipping the user) are in
 * `__integration__/user-lifecycle.integration.test.ts`.
 */

const lifecycleMocks = vi.hoisted(() => ({
  revokeOAuthConnection: vi.fn(),
  cancelRun: vi.fn(),
}));
vi.mock("@/lib/oauth/connection", () => ({
  revokeOAuthConnection: lifecycleMocks.revokeOAuthConnection,
}));
vi.mock("@/lib/run-actions", () => ({
  cancelRun: lifecycleMocks.cancelRun,
}));

import {
  deprovisionUser,
  reactivateUser,
  suspendUser,
} from "@/lib/user-lifecycle";

const CLOCK = new Date("2026-11-19T09:30:00.000Z");

const admin: SessionUser = {
  id: "admin-1",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};

interface FakeState {
  target?: { id: string; role: "admin" | "user"; status: string };
  otherActiveAdmins?: Array<{ id: string }>;
  providers?: Array<{ provider: string }>;
  scheduleIds?: string[];
  triggerIds?: string[];
  runIds?: string[];
  sessionVersionAfter?: number;
}

/**
 * Plays the transaction back against canned rows, by table, and records
 * every write. `users` selects resolve in order: the target, then the other
 * active admins.
 */
function fakeDb(state: FakeState) {
  const writes: {
    updates: Array<{ table: unknown; values: Record<string, unknown> }>;
    inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
    transactions: number;
  } = { updates: [], inserts: [], transactions: 0 };
  const usersReads = [
    state.target ? [state.target] : [],
    state.otherActiveAdmins ?? [],
  ];

  function rowsFor(table: unknown): unknown[] {
    if (table === users) return usersReads.shift() ?? [];
    if (table === oauthTokens) return state.providers ?? [];
    if (table === runs) return (state.runIds ?? []).map((id) => ({ id }));
    return [];
  }

  function selectChain() {
    return {
      from(table: unknown) {
        return {
          where() {
            const rows = Promise.resolve(rowsFor(table));
            const chain = Object.assign(rows, {
              limit: () => chain,
              for: () => chain,
            });
            return chain;
          },
        };
      },
    };
  }

  function returningFor(table: unknown) {
    if (table === users) {
      return [{ sessionVersion: state.sessionVersionAfter ?? 1 }];
    }
    if (table === schedules) {
      return (state.scheduleIds ?? []).map((id) => ({ id }));
    }
    if (table === eventTriggers) {
      return (state.triggerIds ?? []).map((id) => ({ id }));
    }
    return [];
  }

  const tx = {
    select: selectChain,
    selectDistinct: selectChain,
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          writes.updates.push({ table, values });
          return {
            where: () => ({ returning: async () => returningFor(table) }),
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: async (values: Record<string, unknown>) => {
          writes.inserts.push({ table, values });
        },
      };
    },
  };
  const db = {
    async transaction<T>(fn: (inner: typeof tx) => Promise<T>) {
      writes.transactions += 1;
      return fn(tx);
    },
  } as unknown as Database;
  return { db, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CLOCK);
  lifecycleMocks.revokeOAuthConnection.mockResolvedValue({
    revoked: true,
    attestations: 0,
  });
  lifecycleMocks.cancelRun.mockResolvedValue({
    ok: true,
    outcome: "canceled",
    run: { id: "run", status: "canceled" },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("suspendUser", () => {
  it("in one transaction: bumps the session version, revokes, disables and cancels, then audits", async () => {
    const { db, writes } = fakeDb({
      target: { id: "user-1", role: "user", status: "active" },
      providers: [{ provider: "github" }, { provider: "google" }],
      scheduleIds: ["schedule-1"],
      triggerIds: ["trigger-1"],
      runIds: ["run-queued", "run-running"],
      sessionVersionAfter: 4,
    });

    const result = await suspendUser("user-1", admin, "  Left the team  ", {
      db,
    });

    expect(writes.transactions).toBe(1);
    expect(result).toEqual({
      ok: true,
      user: {
        id: "user-1",
        status: "suspended",
        statusChangedAt: CLOCK,
        statusReason: "Left the team",
      },
      effects: {
        sessionVersion: 4,
        revokedConnections: ["github", "google"],
        disabledScheduleIds: ["schedule-1"],
        disabledEventTriggerIds: ["trigger-1"],
        canceledRunIds: ["run-queued", "run-running"],
        uncanceledRunIds: [],
      },
    });

    const userUpdate = writes.updates.find((u) => u.table === users)!;
    expect(userUpdate.values).toMatchObject({
      status: "suspended",
      statusChangedAt: CLOCK,
      statusReason: "Left the team",
    });
    // `session_version + 1`, computed by Postgres, not read-modify-write.
    expect(userUpdate.values.sessionVersion).toBeDefined();

    expect(lifecycleMocks.revokeOAuthConnection).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.revokeOAuthConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        provider: "github",
        actorUserId: admin.id,
        reason: "Account suspended: Left the team",
        source: "user_lifecycle",
        now: CLOCK,
      }),
    );
    expect(
      writes.updates.find((u) => u.table === schedules)!.values,
    ).toEqual({ enabled: false, updatedAt: CLOCK });
    expect(
      writes.updates.find((u) => u.table === eventTriggers)!.values,
    ).toEqual({ enabled: false, updatedAt: CLOCK });
    expect(lifecycleMocks.cancelRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: admin,
        runId: "run-queued",
        ownerUserId: "user-1",
        error: "Canceled: the account was suspended.",
      }),
    );

    expect(writes.inserts).toEqual([
      {
        table: auditLog,
        values: expect.objectContaining({
          actorUserId: admin.id,
          actionType: "user.suspended",
          status: "succeeded",
          input: { subjectUserId: "user-1" },
          metadata: expect.objectContaining({
            previousStatus: "active",
            newStatus: "suspended",
            reason: "Left the team",
            sessionVersion: 4,
            canceledRunIds: ["run-queued", "run-running"],
          }),
          startedAt: CLOCK,
          completedAt: CLOCK,
        }),
      },
    ]);
  });

  it("records a run the cancel path would not cancel instead of failing the suspension", async () => {
    lifecycleMocks.cancelRun.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "unsupported_run_type",
      message: "",
    });
    const { db } = fakeDb({
      target: { id: "user-1", role: "user", status: "active" },
      runIds: ["run-workflow"],
    });

    const result = await suspendUser("user-1", admin, "Investigation", { db });

    expect(result.ok && result.effects.uncanceledRunIds).toEqual([
      "run-workflow",
    ]);
  });

  it("suspends another admin while a second active admin remains", async () => {
    const { db } = fakeDb({
      target: { id: "admin-2", role: "admin", status: "active" },
      otherActiveAdmins: [{ id: admin.id }],
    });
    const result = await suspendUser("admin-2", admin, "Rotation", { db });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["an empty reason", ""],
    ["a reason over 500 characters", "x".repeat(501)],
    ["a missing reason", undefined],
  ])("refuses %s before opening a transaction", async (_label, reason) => {
    const { db, writes } = fakeDb({
      target: { id: "user-1", role: "user", status: "active" },
    });
    await expect(suspendUser("user-1", admin, reason, { db })).resolves.toEqual({
      ok: false,
      status: 400,
      error: "invalid_reason",
    });
    expect(writes.transactions).toBe(0);
  });

  it("refuses to suspend the acting admin", async () => {
    const { db, writes } = fakeDb({
      target: { id: admin.id, role: "admin", status: "active" },
      otherActiveAdmins: [{ id: "admin-2" }],
    });
    await expect(suspendUser(admin.id, admin, "Oops", { db })).resolves.toEqual(
      { ok: false, status: 400, error: "cannot_change_self" },
    );
    expect(writes.transactions).toBe(0);
  });

  it("refuses to suspend the last active admin and writes nothing", async () => {
    const { db, writes } = fakeDb({
      target: { id: "admin-2", role: "admin", status: "active" },
      otherActiveAdmins: [],
    });
    await expect(suspendUser("admin-2", admin, "Rotation", { db })).resolves.toEqual(
      { ok: false, status: 409, error: "last_admin" },
    );
    expect(writes.updates).toHaveLength(0);
    expect(writes.inserts).toHaveLength(0);
  });

  it("404s an unknown user and 409s one that is not active", async () => {
    await expect(
      suspendUser("missing", admin, "Reason", { db: fakeDb({}).db }),
    ).resolves.toEqual({ ok: false, status: 404, error: "user_not_found" });

    const { db, writes } = fakeDb({
      target: { id: "user-1", role: "user", status: "suspended" },
    });
    await expect(suspendUser("user-1", admin, "Reason", { db })).resolves.toEqual(
      { ok: false, status: 409, error: "invalid_transition" },
    );
    expect(writes.updates).toHaveLength(0);
  });
});

describe("deprovisionUser", () => {
  it("deprovisions a suspended user with the same withdrawals", async () => {
    const { db, writes } = fakeDb({
      target: { id: "user-1", role: "user", status: "suspended" },
      scheduleIds: [],
    });

    const result = await deprovisionUser("user-1", admin, "Left the company", {
      db,
    });

    expect(result).toMatchObject({
      ok: true,
      user: { status: "deprovisioned", statusChangedAt: CLOCK },
    });
    expect(
      writes.updates.find((u) => u.table === users)!.values.sessionVersion,
    ).toBeDefined();
    expect(writes.inserts[0]!.values).toMatchObject({
      actionType: "user.deprovisioned",
      metadata: expect.objectContaining({
        previousStatus: "suspended",
        newStatus: "deprovisioned",
      }),
    });
  });

  it("does not count a suspended admin as the last active admin", async () => {
    const { db } = fakeDb({
      target: { id: "admin-2", role: "admin", status: "suspended" },
    });
    const result = await deprovisionUser("admin-2", admin, "Left", { db });
    expect(result.ok).toBe(true);
  });
});

describe("reactivateUser", () => {
  it("restores sign-in only: no version bump, nothing re-enabled", async () => {
    const { db, writes } = fakeDb({
      target: { id: "user-1", role: "user", status: "suspended" },
      sessionVersionAfter: 4,
    });

    const result = await reactivateUser("user-1", admin, "Cleared", { db });

    expect(result).toEqual({
      ok: true,
      user: {
        id: "user-1",
        status: "active",
        statusChangedAt: CLOCK,
        statusReason: "Cleared",
      },
      effects: {
        sessionVersion: 4,
        revokedConnections: [],
        disabledScheduleIds: [],
        disabledEventTriggerIds: [],
        canceledRunIds: [],
        uncanceledRunIds: [],
      },
    });
    expect(writes.updates).toEqual([
      {
        table: users,
        values: {
          status: "active",
          statusChangedAt: CLOCK,
          statusReason: "Cleared",
        },
      },
    ]);
    expect(lifecycleMocks.revokeOAuthConnection).not.toHaveBeenCalled();
    expect(lifecycleMocks.cancelRun).not.toHaveBeenCalled();
    expect(writes.inserts[0]!.values).toMatchObject({
      actionType: "user.reactivated",
    });
  });

  it("refuses to reactivate an active user", async () => {
    const { db } = fakeDb({
      target: { id: "user-1", role: "user", status: "active" },
    });
    await expect(reactivateUser("user-1", admin, "Why", { db })).resolves.toEqual(
      { ok: false, status: 409, error: "invalid_transition" },
    );
  });
});
