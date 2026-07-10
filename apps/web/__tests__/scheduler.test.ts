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

function schedulerDb(skill: Skill): {
  db: Database;
  updates: Array<Record<string, unknown>>;
} {
  let selectCount = 0;
  let updateCount = 0;
  const updates: Array<Record<string, unknown>> = [];

  const db = {
    select: () => {
      selectCount += 1;
      const rows = selectCount === 1 ? [{ id: schedule.id }] : [skill];
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
        returning: async () => (updateCount === 1 ? [schedule] : []),
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
