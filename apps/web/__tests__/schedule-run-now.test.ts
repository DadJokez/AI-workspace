import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Schedule, Skill } from "@ai-workspace/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * #780 "Run now" on a schedule. The fire path is the scheduler's own; what
 * this suite pins is everything around it: the owner predicate (rendered
 * SQL — a mocked db otherwise discards the WHERE clause), the manual trigger
 * marker, that the schedule row is never advanced, the double-fire guard,
 * and the provider gate. Plus the per-schedule history query's scoping.
 */

const skillMocks = vi.hoisted(() => ({
  checkSkillProviderAccess: vi.fn(),
  createSkillRun: vi.fn(),
}));

vi.mock("@/lib/skills", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/skills")>("@/lib/skills");
  return {
    ...actual,
    checkSkillProviderAccess: skillMocks.checkSkillProviderAccess,
    createSkillRun: skillMocks.createSkillRun,
  };
});

import { runScheduleNow } from "@/lib/schedules/scheduler";
import {
  hasInFlightScheduleRun,
  listScheduleRunHistory,
} from "@/lib/schedules/run-history";

const owner = { id: "user-owner" };
const stranger = { id: "user-stranger" };
const nextRunAt = new Date("2026-09-07T08:00:00.000Z");

const schedule = {
  id: "schedule-1",
  userId: owner.id,
  skillId: "skill-1",
  enabled: true,
  cadence: "0 8 * * MON",
  timezone: "UTC",
  nextRunAt,
  lastRunAt: null,
  targetThreadId: "thread-1",
  claimedAt: null,
  claimedBy: null,
  lastError: null,
} as unknown as Schedule;

const skill = {
  id: "skill-1",
  slug: "weekly-status",
  name: "Weekly Status",
  systemPrompt: "Draft the weekly status.",
  modelId: "sonnet-4-6",
  mcpProviders: ["google"],
  ownerUserId: owner.id,
  isStarter: false,
  archivedAt: null,
} as unknown as Skill;

const accessReady = {
  ready: ["google"],
  missingConnections: [],
  deniedAttestations: [],
  executionUnavailable: [],
  reconnectRequired: [],
  temporarilyUnavailable: [],
};

/**
 * Chainable Drizzle fake (same shape as run-actions.test.ts): select results
 * resolve in call order; every select WHERE, update SET and insert VALUES is
 * captured so predicates and writes can be asserted.
 */
function fakeDb(selectResults: unknown[][]) {
  const captured = {
    selectWheres: [] as SQL[],
    updateSets: [] as Array<Record<string, unknown>>,
    inserts: [] as Array<Record<string, unknown>>,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          captured.selectWheres.push(condition);
          const rows = selectResults.shift() ?? [];
          const chain = {
            orderBy: () => chain,
            limit: async () => rows,
          };
          return chain;
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.updateSets.push(values);
        return { where: async () => [] };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.inserts.push(values);
        return { returning: async () => [{ id: "thread-new" }] };
      },
    }),
  } as unknown as Database;
  return { db, captured };
}

function render(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

beforeEach(() => {
  vi.clearAllMocks();
  skillMocks.checkSkillProviderAccess.mockResolvedValue(accessReady);
  skillMocks.createSkillRun.mockResolvedValue({
    runId: "run-manual",
    threadId: "thread-1",
  });
});

describe("runScheduleNow", () => {
  it("rejects a schedule the actor does not own with 404 and leaves no trace", async () => {
    const { db, captured } = fakeDb([[]]);

    const result = await runScheduleNow({
      db,
      actor: stranger,
      scheduleId: schedule.id,
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "schedule_not_found",
    });
    // Same predicate the schedule PATCH/DELETE routes use: id AND owner.
    const query = render(captured.selectWheres[0]!);
    expect(query.sql).toContain('"id" =');
    expect(query.sql).toContain('"user_id" =');
    expect(query.params).toEqual([schedule.id, stranger.id]);
    expect(captured.selectWheres).toHaveLength(1);
    expect(captured.updateSets).toEqual([]);
    expect(captured.inserts).toEqual([]);
    expect(skillMocks.checkSkillProviderAccess).not.toHaveBeenCalled();
    expect(skillMocks.createSkillRun).not.toHaveBeenCalled();
  });

  it("fires through the scheduler path with the manual marker and never advances the schedule", async () => {
    const { db, captured } = fakeDb([[schedule], [skill], []]);

    const result = await runScheduleNow({
      db,
      actor: owner,
      scheduleId: schedule.id,
    });

    expect(result).toEqual({ ok: true, runId: "run-manual", threadId: "thread-1" });
    expect(skillMocks.checkSkillProviderAccess).toHaveBeenCalledWith(
      db,
      owner.id,
      ["google"],
    );
    expect(skillMocks.createSkillRun).toHaveBeenCalledTimes(1);
    expect(skillMocks.createSkillRun).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        actorUserId: owner.id,
        skill: expect.objectContaining({ id: skill.id }),
        triggerType: "scheduled",
        scheduleId: schedule.id,
        scheduleFire: "manual",
        threadId: "thread-1",
      }),
    );
    // No schedule write at all: next_run_at, last_run_at and the lease stay
    // exactly where the cadence left them.
    expect(captured.updateSets).toEqual([]);
    expect(captured.inserts).toEqual([]);
    expect(schedule.nextRunAt).toBe(nextRunAt);
  });

  it("scopes the in-flight guard to the schedule and its owner", async () => {
    const { db, captured } = fakeDb([[schedule], [skill], []]);

    await runScheduleNow({ db, actor: owner, scheduleId: schedule.id });

    const query = render(captured.selectWheres[2]!);
    expect(query.sql).toContain('"schedule_id" =');
    expect(query.sql).toContain('"user_id" =');
    expect(query.sql).toContain('"status" in');
    expect(query.params).toEqual([schedule.id, owner.id, "queued", "running"]);
  });

  it("binds the dedicated thread on first fire exactly like the cadence path", async () => {
    const { db, captured } = fakeDb([
      [{ ...schedule, targetThreadId: null }],
      [skill],
      [],
    ]);

    const result = await runScheduleNow({
      db,
      actor: owner,
      scheduleId: schedule.id,
    });

    expect(result).toMatchObject({ ok: true });
    expect(captured.inserts[0]).toMatchObject({
      userId: owner.id,
      title: "Scheduled: Weekly Status",
      defaultModelId: "sonnet-4-6",
    });
    // The only schedule write is the thread bind — no cadence fields.
    expect(captured.updateSets).toHaveLength(1);
    expect(Object.keys(captured.updateSets[0]!).sort()).toEqual([
      "targetThreadId",
      "updatedAt",
    ]);
    expect(captured.updateSets[0]).toMatchObject({ targetThreadId: "thread-new" });
    expect(skillMocks.createSkillRun).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-new", scheduleFire: "manual" }),
    );
  });

  it("refuses to double-fire while a run for the schedule is queued or running", async () => {
    const { db, captured } = fakeDb([[schedule], [skill], [{ id: "run-live" }]]);

    const result = await runScheduleNow({
      db,
      actor: owner,
      scheduleId: schedule.id,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "run_in_flight",
    });
    expect(skillMocks.checkSkillProviderAccess).not.toHaveBeenCalled();
    expect(skillMocks.createSkillRun).not.toHaveBeenCalled();
    expect(captured.updateSets).toEqual([]);
  });

  it("gates on provider access before anything is enqueued", async () => {
    const { db, captured } = fakeDb([[schedule], [skill], []]);
    const blocked = { ...accessReady, ready: [], missingConnections: ["google"] };
    skillMocks.checkSkillProviderAccess.mockResolvedValue(blocked);

    const result = await runScheduleNow({
      db,
      actor: owner,
      scheduleId: schedule.id,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "provider_access_required",
      access: blocked,
    });
    expect(skillMocks.createSkillRun).not.toHaveBeenCalled();
    expect(captured.inserts).toEqual([]);
    expect(captured.updateSets).toEqual([]);
  });

  it("reports an archived skill instead of silently disabling the schedule", async () => {
    const { db, captured } = fakeDb([
      [schedule],
      [{ ...skill, archivedAt: new Date("2026-09-01T00:00:00.000Z") }],
    ]);

    const result = await runScheduleNow({
      db,
      actor: owner,
      scheduleId: schedule.id,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "skill_unavailable",
      message: expect.stringContaining("archived"),
    });
    // The cadence path disables the schedule here; a manual fire is a
    // request the user is watching, so it only answers — it edits nothing.
    expect(captured.updateSets).toEqual([]);
    expect(skillMocks.createSkillRun).not.toHaveBeenCalled();
  });
});

describe("schedule run history", () => {
  it("lists a schedule's runs scoped to the requesting user, newest first, capped", async () => {
    const createdAt = new Date("2026-09-04T08:00:00.000Z");
    const { db, captured } = fakeDb([
      [
        {
          id: "run-2",
          status: "succeeded",
          threadId: "thread-1",
          inputs: { scheduleFire: "manual", prompt: "…" },
          outputs: null,
          error: null,
          createdAt,
          startedAt: createdAt,
          completedAt: new Date(createdAt.getTime() + 4_000),
        },
        {
          id: "run-1",
          status: "failed",
          threadId: "thread-1",
          inputs: { prompt: "…" },
          outputs: null,
          error: "boom",
          createdAt: new Date(createdAt.getTime() - 60_000),
          startedAt: null,
          completedAt: null,
        },
      ],
    ]);

    const history = await listScheduleRunHistory({
      db,
      userId: owner.id,
      scheduleId: schedule.id,
    });

    const query = render(captured.selectWheres[0]!);
    expect(query.sql).toContain('"schedule_id" =');
    expect(query.sql).toContain('"user_id" =');
    expect(query.params).toEqual([schedule.id, owner.id]);
    expect(history).toEqual([
      expect.objectContaining({
        id: "run-2",
        status: "succeeded",
        scheduleFire: "manual",
        truncatedBy: null,
      }),
      expect.objectContaining({
        id: "run-1",
        status: "failed",
        scheduleFire: null,
        error: "boom",
      }),
    ]);
  });

  it("answers the in-flight guard from the same scoped predicate", async () => {
    const { db, captured } = fakeDb([[]]);

    expect(
      await hasInFlightScheduleRun({
        db,
        userId: stranger.id,
        scheduleId: schedule.id,
      }),
    ).toBe(false);
    const query = render(captured.selectWheres[0]!);
    expect(query.params).toEqual([schedule.id, stranger.id, "queued", "running"]);
  });
});
