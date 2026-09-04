import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  createDb,
  runEvents,
  runs,
  schedules,
  skills,
  users,
} from "@ai-workspace/db";
import type { SessionUser } from "@ai-workspace/auth";
import { listScheduleRunHistory } from "@/lib/schedules/run-history";

/**
 * #780 "Run now" against real Postgres through the REAL route handler: the
 * owner predicate (bob gets a 404 on alice's schedule), the manual trigger
 * marker on the run row / run event / audit row, the untouched schedule
 * row, the double-fire guard, and the per-schedule history scoping.
 */

const DB_URL = process.env.DATABASE_URL;

// #479 retro-review: never green-by-skip in CI (see scoping suite).
if (!DB_URL && process.env.CI) {
  throw new Error(
    "schedule run-now integration suite: DATABASE_URL is empty in CI — the " +
      "INTEGRATION_DATABASE_URL plumbing is broken; refusing to green-by-skip.",
  );
}

// Enqueue only: this lane has no runtime, so the queued run must stay queued
// (which is also what the double-fire guard needs to observe).
process.env.CHAT_RUN_IN_PROCESS_WORKER = "0";

let currentUser: SessionUser | null = null;
vi.mock("@/lib/auth/getSessionUser", () => ({
  getSessionUser: async () => currentUser,
}));

const suite = describe.skipIf(!DB_URL);

suite("schedule Run now (real Postgres, real handler)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 4 });

  let alice: SessionUser;
  let bob: SessionUser;
  let scheduleId: string;
  const nextRunAt = new Date("2030-01-06T13:00:00.000Z");

  async function seed() {
    const [a, b] = await db
      .insert(users)
      .values([
        {
          pingSubject: "it-run-now-alice",
          email: "run-now-alice@example.com",
          displayName: "Alice",
          role: "user",
        },
        {
          pingSubject: "it-run-now-bob",
          email: "run-now-bob@example.com",
          displayName: "Bob",
          role: "user",
        },
      ])
      .returning();
    const asSession = (u: typeof a): SessionUser =>
      ({
        id: u!.id,
        email: u!.email,
        displayName: u!.displayName,
        role: u!.role,
      }) as SessionUser;
    alice = asSession(a);
    bob = asSession(b);

    const [skill] = await db
      .insert(skills)
      .values({
        slug: `it-run-now-${Date.now()}`,
        name: "Weekly status",
        ownerUserId: alice.id,
        systemPrompt: "Draft the weekly status.",
        modelId: "sonnet-4-6",
        mcpProviders: [],
      })
      .returning();
    const [schedule] = await db
      .insert(schedules)
      .values({
        userId: alice.id,
        skillId: skill!.id,
        cadence: "0 8 * * MON",
        timezone: "America/New_York",
        nextRunAt,
      })
      .returning();
    scheduleId = schedule!.id;
  }

  async function post(id: string) {
    const { POST } = await import("@/app/api/schedules/[id]/run/route");
    return POST(
      new Request(`http://test.local/api/schedules/${id}/run`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    // users cascade wipes skills/schedules/threads/runs between specs.
    await db.delete(users);
    await seed();
  });

  afterAll(async () => {
    await db.delete(users);
  });

  it("is a 404 for a schedule the caller does not own, with nothing enqueued", async () => {
    currentUser = bob;
    const res = await post(scheduleId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "schedule_not_found" });

    const enqueued = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.scheduleId, scheduleId));
    expect(enqueued).toHaveLength(0);
  });

  it("fires the owner's schedule as a scheduled run carrying the manual marker, without advancing it", async () => {
    currentUser = alice;
    const res = await post(scheduleId);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; threadId: string };

    const [run] = await db.select().from(runs).where(eq(runs.id, body.runId));
    expect(run).toMatchObject({
      userId: alice.id,
      scheduleId,
      threadId: body.threadId,
      triggerType: "scheduled",
      status: "queued",
    });
    expect(run!.inputs).toMatchObject({
      scheduleId,
      scheduleFire: "manual",
      autonomyPreset: "unattended",
      runBudget: expect.objectContaining({ envelope: expect.anything() }),
    });

    const [queuedEvent] = await db
      .select()
      .from(runEvents)
      .where(
        and(eq(runEvents.runId, body.runId), eq(runEvents.eventType, "run_queued")),
      );
    expect(queuedEvent!.metadata).toMatchObject({ scheduleId, scheduleFire: "manual" });

    const fires = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actionType, "schedule_fire"),
          eq(auditLog.actorUserId, alice.id),
        ),
      );
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({
      runId: body.runId,
      metadata: expect.objectContaining({
        triggerType: "scheduled",
        scheduleId,
        scheduleFire: "manual",
        autonomyPreset: "unattended",
      }),
    });

    // The schedule row: next/last occurrence untouched; only the first-fire
    // thread bind happened.
    const [schedule] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, scheduleId));
    expect(schedule!.nextRunAt.toISOString()).toBe(nextRunAt.toISOString());
    expect(schedule!.lastRunAt).toBeNull();
    expect(schedule!.enabled).toBe(true);
    expect(schedule!.claimedAt).toBeNull();
    expect(schedule!.targetThreadId).toBe(body.threadId);
  });

  it("refuses a second fire while the first is still queued", async () => {
    currentUser = alice;
    expect((await post(scheduleId)).status).toBe(202);

    const second = await post(scheduleId);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "run_in_flight" });

    const enqueued = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.scheduleId, scheduleId));
    expect(enqueued).toHaveLength(1);
  });

  it("lists the schedule's history for its owner only", async () => {
    currentUser = alice;
    expect((await post(scheduleId)).status).toBe(202);

    const mine = await listScheduleRunHistory({
      db,
      userId: alice.id,
      scheduleId,
    });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "queued", scheduleFire: "manual" });

    const theirs = await listScheduleRunHistory({
      db,
      userId: bob.id,
      scheduleId,
    });
    expect(theirs).toEqual([]);
  });
});
