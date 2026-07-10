import { describe, expect, it } from "vitest";
import type { Database, Run } from "@ai-workspace/db";
import {
  buildDigest,
  createProactiveRunNotification,
  listNotifications,
  openNotification,
} from "@/lib/notifications";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000010";
const SKILL_ID = "00000000-0000-4000-8000-000000000020";
const THREAD_ID = "00000000-0000-4000-8000-000000000030";

function scheduledRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    userId: USER_ID,
    skillId: SKILL_ID,
    skillSlug: "weekly-status",
    scheduleId: "00000000-0000-4000-8000-000000000040",
    threadId: THREAD_ID,
    triggerType: "scheduled",
    status: "running",
    error: null,
    ...overrides,
  } as Run;
}

/**
 * Chainable fake for the Drizzle query builder: every builder method returns
 * the chain; terminal methods resolve from `selectResults` in call order.
 * Captures insert/update payloads for assertions.
 */
function fakeDb(selectResults: Array<Array<Record<string, unknown>>> = []) {
  const captured: {
    inserts: Array<Record<string, unknown>>;
    conflictTargets: unknown[];
    updates: Array<Record<string, unknown>>;
    updateReturning: Array<Record<string, unknown>>;
  } = { inserts: [], conflictTargets: [], updates: [], updateReturning: [] };

  const nextSelect = () => Promise.resolve(selectResults.shift() ?? []);

  function selectChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.leftJoin = () => chain;
    chain.where = () => {
      const pending = nextSelect();
      const terminal = Object.assign(pending, {
        orderBy: () => pending,
        limit: () => pending,
      });
      return terminal;
    };
    return chain;
  }

  const db = {
    select: () => selectChain(),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.inserts.push(values);
        return {
          onConflictDoNothing: (arg: unknown) => {
            captured.conflictTargets.push(arg);
            return Promise.resolve();
          },
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.updates.push(values);
        return {
          where: () =>
            Object.assign(Promise.resolve(), {
              returning: () => Promise.resolve(captured.updateReturning),
            }),
        };
      },
    }),
  } as unknown as Database;

  return { db, captured };
}

describe("createProactiveRunNotification", () => {
  it("writes exactly one owner-scoped notification for a scheduled run", async () => {
    const { db, captured } = fakeDb([[{ name: "Weekly Status" }]]);

    await createProactiveRunNotification(db, scheduledRun(), "succeeded");

    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]).toMatchObject({
      userId: USER_ID,
      type: "run_succeeded",
      title: "Weekly Status finished",
      runId: RUN_ID,
      threadId: THREAD_ID,
    });
    // Idempotency across worker retries rides on the run_id unique index.
    expect(captured.conflictTargets).toHaveLength(1);
    expect(captured.conflictTargets[0]).toBeTruthy();
  });

  it("produces a distinguishable failure notification carrying the error", async () => {
    const { db, captured } = fakeDb([[{ name: "Weekly Status" }]]);

    await createProactiveRunNotification(
      db,
      scheduledRun({ error: "Bedrock timed out" }),
      "failed",
    );

    expect(captured.inserts[0]).toMatchObject({
      type: "run_failed",
      title: "Weekly Status failed",
      body: "Bedrock timed out",
    });
  });

  it("notifies the owner when a GitHub event-triggered run finishes", async () => {
    const { db, captured } = fakeDb([[{ name: "PR Review" }]]);

    await createProactiveRunNotification(
      db,
      scheduledRun({
        triggerType: "github_event",
        scheduleId: null,
        eventTriggerId: "00000000-0000-4000-8000-000000000293",
        eventDeliveryId: "delivery-293",
      }),
      "succeeded",
    );

    expect(captured.inserts[0]).toMatchObject({
      userId: USER_ID,
      title: "PR Review finished",
      body: expect.stringContaining("GitHub event"),
      runId: RUN_ID,
      threadId: THREAD_ID,
    });
  });

  it("notifies the owner when a durable chat run finishes", async () => {
    for (const triggerType of ["chat", "chat_retry"]) {
      const { db, captured } = fakeDb();

      await createProactiveRunNotification(
        db,
        scheduledRun({
          triggerType,
          skillId: null,
          skillSlug: "chat-turn",
          scheduleId: null,
        }),
        "succeeded",
      );

      expect(captured.inserts[0]).toMatchObject({
        userId: USER_ID,
        title: "Chat finished",
        body:
          "Your background chat run finished. Open the thread to see the answer.",
        runId: RUN_ID,
        threadId: THREAD_ID,
      });
    }
  });

  it("does nothing for manual skill runs", async () => {
    for (const triggerType of ["manual", "skill", "skill_retry"]) {
      const { db, captured } = fakeDb();
      await createProactiveRunNotification(
        db,
        scheduledRun({ triggerType }),
        "succeeded",
      );
      expect(captured.inserts).toHaveLength(0);
    }
  });

  it("falls back to the skill slug when the skill row is gone", async () => {
    const { db, captured } = fakeDb([[]]);

    await createProactiveRunNotification(db, scheduledRun(), "succeeded");

    expect(captured.inserts[0]).toMatchObject({
      title: "weekly-status finished",
    });
  });

  it("never throws — a notification failure must not fail the run", async () => {
    const db = {
      select: () => {
        throw new Error("db down");
      },
    } as unknown as Database;

    await expect(
      createProactiveRunNotification(db, scheduledRun(), "succeeded"),
    ).resolves.toBeUndefined();
  });

  it("prefers the output thread the worker actually wrote to", async () => {
    const { db, captured } = fakeDb([[{ name: "Weekly Status" }]]);
    const outputThread = "00000000-0000-4000-8000-000000000099";

    await createProactiveRunNotification(
      db,
      scheduledRun(),
      "succeeded",
      outputThread,
    );

    expect(captured.inserts[0]).toMatchObject({ threadId: outputThread });
  });
});

describe("listNotifications", () => {
  it("returns rows and the unread count", async () => {
    const rows = [{ id: "n1", readAt: null }];
    const { db } = fakeDb([rows, [{ value: 3 }]]);

    const result = await listNotifications(db, USER_ID);

    expect(result.notifications).toEqual(rows);
    expect(result.unreadCount).toBe(3);
  });
});

describe("openNotification", () => {
  it("returns the row and stamps read + accepted", async () => {
    const { db, captured } = fakeDb();
    captured.updateReturning.push({ id: "n1" });

    const result = await openNotification(db, USER_ID, "n1");

    expect(result).toMatchObject({ id: "n1" });
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]).toHaveProperty("readAt");
    expect(captured.updates[0]).toHaveProperty("acceptedAt");
  });

  it("returns null for another user's (or a missing) notification", async () => {
    const { db } = fakeDb();

    const result = await openNotification(db, USER_ID, "not-mine");

    expect(result).toBeNull();
  });
});

describe("buildDigest", () => {
  it("splits terminal runs by status, names shares, and advances the cursor", async () => {
    const viewedAt = new Date("2026-07-01T00:00:00Z");
    const { db, captured } = fakeDb([
      [{ digestViewedAt: viewedAt }],
      [
        {
          id: "r1",
          status: "succeeded",
          skillName: "Weekly Status",
          skillSlug: "weekly-status",
          threadId: THREAD_ID,
          error: null,
          completedAt: new Date("2026-07-02T00:00:00Z"),
        },
        {
          id: "r2",
          status: "failed",
          skillName: "Meeting Prep",
          skillSlug: "meeting-prep",
          threadId: null,
          error: "boom",
          completedAt: new Date("2026-07-02T01:00:00Z"),
        },
      ],
      [
        {
          id: "s1",
          subjectType: "app",
          skillName: null,
          appName: "Team Dashboard",
          grantedByName: "Nina",
          createdAt: new Date("2026-07-02T02:00:00Z"),
        },
      ],
    ]);

    const digest = await buildDigest(db, USER_ID);

    expect(digest.since).toEqual(viewedAt);
    expect(digest.completedRuns.map((r) => r.id)).toEqual(["r1"]);
    expect(digest.failedRuns.map((r) => r.id)).toEqual(["r2"]);
    expect(digest.newShares).toEqual([
      expect.objectContaining({
        id: "s1",
        subjectType: "app",
        subjectName: "Team Dashboard",
        grantedByName: "Nina",
      }),
    ]);
    // The cursor advanced so the next digest starts where this one ended.
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]?.digestViewedAt).toBeInstanceOf(Date);
  });

  it("falls back to a 24h window when the digest was never viewed", async () => {
    const now = new Date("2026-07-06T12:00:00Z");
    const { db } = fakeDb([[{ digestViewedAt: null }], [], []]);

    const digest = await buildDigest(db, USER_ID, now);

    expect(digest.since).toEqual(new Date("2026-07-05T12:00:00Z"));
    expect(digest.completedRuns).toEqual([]);
    expect(digest.failedRuns).toEqual([]);
    expect(digest.newShares).toEqual([]);
  });
});
