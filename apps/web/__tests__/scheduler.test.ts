import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Schedule, Skill } from "@ai-workspace/db";

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

import { processDueSchedules } from "@/lib/schedules/scheduler";

const now = new Date("2026-07-09T12:00:00.000Z");
const schedule = {
  id: "schedule-1",
  userId: "user-1",
  skillId: "starter-meeting-prep",
  enabled: true,
  cadence: "0 8 * * *",
  timezone: "UTC",
  nextRunAt: now,
  targetThreadId: null,
  claimedAt: null,
  claimedBy: null,
} as unknown as Schedule;
const staleMeetingPrep = {
  id: "starter-meeting-prep",
  slug: "meeting-prep",
  name: "Meeting Prep",
  description: "Old description",
  systemPrompt: "Old prompt",
  modelId: "sonnet-4-6",
  mcpProviders: [],
  ownerUserId: "admin-1",
  isStarter: true,
  archivedAt: null,
} as unknown as Skill;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("processDueSchedules", () => {
  it("fires a due schedule on cadence with the cadence marker, then advances past the occurrence", async () => {
    const { db, updates } = schedulerDb(
      { ...staleMeetingPrep, mcpProviders: [] },
      { ...schedule, targetThreadId: "thread-1" },
    );
    skillMocks.checkSkillProviderAccess.mockResolvedValue({
      ready: [],
      missingConnections: [],
      deniedAttestations: [],
      executionUnavailable: [],
      reconnectRequired: [],
      temporarilyUnavailable: [],
    });
    skillMocks.createSkillRun.mockResolvedValue({
      runId: "run-1",
      threadId: "thread-1",
    });

    const result = await processDueSchedules({ db, workerId: "worker-1", now });

    expect(result).toEqual({ fired: 1, failed: 0 });
    // #780: the cadence fire and "Run now" share this path; the marker is
    // the one thing that tells them apart on the run.
    expect(skillMocks.createSkillRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: schedule.userId,
        triggerType: "scheduled",
        scheduleId: schedule.id,
        scheduleFire: "cadence",
        threadId: "thread-1",
      }),
    );
    expect(updates.at(-1)).toMatchObject({
      lastRunAt: now,
      nextRunAt: expect.any(Date),
      claimedAt: null,
      claimedBy: null,
      lastError: null,
    });
    expect((updates.at(-1)!.nextRunAt as Date).getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });

  it("drops the occurrence instead of stacking a second run while one is queued or running", async () => {
    // Pair of runScheduleNow's guard: a due schedule fired manually (which
    // never advances next_run_at) is claimed by the next tick; the cadence
    // must defer to the live run, not enqueue a second one into the thread.
    const { db, updates } = schedulerDb(
      { ...staleMeetingPrep, mcpProviders: [] },
      { ...schedule, targetThreadId: "thread-1" },
      [{ id: "run-manual" }],
    );
    skillMocks.checkSkillProviderAccess.mockResolvedValue({
      ready: [],
      missingConnections: [],
      deniedAttestations: [],
      executionUnavailable: [],
      reconnectRequired: [],
      temporarilyUnavailable: [],
    });

    const result = await processDueSchedules({ db, workerId: "worker-1", now });

    expect(result).toEqual({ fired: 0, failed: 0 });
    expect(skillMocks.createSkillRun).not.toHaveBeenCalled();
    // The occurrence is consumed exactly like a fire: claim released,
    // next_run_at advanced, no error recorded.
    expect(updates.at(-1)).toMatchObject({
      lastRunAt: now,
      nextRunAt: expect.any(Date),
      claimedAt: null,
      claimedBy: null,
      lastError: null,
    });
    expect((updates.at(-1)!.nextRunAt as Date).getTime()).toBeGreaterThan(
      now.getTime(),
    );
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('"reason":"run_in_flight"'),
    );
  });

  it("does not enqueue a stale starter when its canonical provider needs reconnecting", async () => {
    const { db, updates } = schedulerDb(staleMeetingPrep);
    skillMocks.checkSkillProviderAccess.mockResolvedValue({
      ready: [],
      missingConnections: [],
      deniedAttestations: [],
      executionUnavailable: [],
      reconnectRequired: ["google"],
      temporarilyUnavailable: [],
    });

    const result = await processDueSchedules({ db, workerId: "worker-1", now });

    expect(result).toEqual({ fired: 0, failed: 1 });
    expect(skillMocks.checkSkillProviderAccess).toHaveBeenCalledWith(
      db,
      schedule.userId,
      ["google"],
    );
    expect(skillMocks.createSkillRun).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      lastError: expect.stringContaining("Provider access required"),
      claimedAt: null,
      claimedBy: null,
    });
  });
});

/**
 * Selects resolve in the scheduler's call order: due candidates, then the
 * skill, then the in-flight run probe (`inFlightRuns`, empty by default).
 */
function schedulerDb(
  skill: Skill,
  claimed: Schedule = schedule,
  inFlightRuns: Array<{ id: string }> = [],
): {
  db: Database;
  updates: Array<Record<string, unknown>>;
} {
  let selectCount = 0;
  let updateCount = 0;
  const updates: Array<Record<string, unknown>> = [];

  const db = {
    select: () => {
      selectCount += 1;
      const rows =
        selectCount === 1
          ? [{ id: claimed.id }]
          : selectCount === 2
            ? [skill]
            : inFlightRuns;
      const terminal = async () => rows;
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: terminal,
      };
      return chain;
    },
    update: () => {
      updateCount += 1;
      let values: Record<string, unknown> = {};
      const terminal = {
        returning: async () => (updateCount === 1 ? [claimed] : []),
        then: (
          resolve: (value: unknown[]) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve([]).then(resolve, reject),
      };
      const chain = {
        set: (next: Record<string, unknown>) => {
          values = next;
          updates.push(values);
          return chain;
        },
        where: () => terminal,
      };
      return chain;
    },
  } as unknown as Database;

  return { db, updates };
}
