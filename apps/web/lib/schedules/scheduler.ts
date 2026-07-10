import {
  chatThreads,
  type Database,
  type Schedule,
  schedules,
  skills,
} from "@ai-workspace/db";
import { and, asc, eq, isNull, lte, lt, or } from "drizzle-orm";
import { computeNextRunAt } from "@/lib/schedules/next-run";
import {
  checkSkillProviderAccess,
  createSkillRun,
  isSkillProviderAccessReady,
} from "@/lib/skills";
import { canonicalizeStarterSkill } from "@/lib/starter-skills";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const CLAIM_STALE_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 10;

/**
 * One scheduler pass (specs/002-skills-spine T301): claim due schedules with
 * the same conditional-update lease semantics the chat-run worker uses, so
 * concurrent worker instances enqueue at most one run per occurrence. The
 * enqueued run is executed by the existing chat-run worker; this module never
 * touches the runtime.
 *
 * `next_run_at` advances from max(scheduled occurrence, now): drift-free in
 * normal operation, and an outage produces exactly one catch-up fire instead
 * of a backfill storm.
 */
export async function processDueSchedules({
  db,
  workerId,
  now = new Date(),
}: {
  db: Database;
  workerId: string;
  now?: Date;
}): Promise<{ fired: number; failed: number }> {
  const staleCutoff = new Date(now.getTime() - CLAIM_STALE_MS);
  const due = await db
    .select({ id: schedules.id })
    .from(schedules)
    .where(
      and(
        eq(schedules.enabled, true),
        lte(schedules.nextRunAt, now),
        or(isNull(schedules.claimedAt), lt(schedules.claimedAt, staleCutoff)),
      ),
    )
    .orderBy(asc(schedules.nextRunAt))
    .limit(BATCH_LIMIT);

  let fired = 0;
  let failed = 0;
  for (const candidate of due) {
    const claimedRows = await db
      .update(schedules)
      .set({ claimedAt: now, claimedBy: workerId, updatedAt: now })
      .where(
        and(
          eq(schedules.id, candidate.id),
          eq(schedules.enabled, true),
          lte(schedules.nextRunAt, now),
          or(isNull(schedules.claimedAt), lt(schedules.claimedAt, staleCutoff)),
        ),
      )
      .returning();
    const schedule = claimedRows[0];
    if (!schedule) continue; // another worker won the claim

    try {
      await fireSchedule({ db, schedule, now });
      fired += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[schedule-fire-error] ${JSON.stringify({
          scheduleId: schedule.id,
          skillId: schedule.skillId,
          message,
        })}\n`,
      );
      // Record the failure and still advance past this occurrence so a
      // persistent error cannot hot-loop the scheduler (T304: the schedule
      // stays enabled and the next occurrence still fires).
      await advanceSchedule({
        db,
        schedule,
        now,
        lastError: message.slice(0, 500),
      });
    }
  }

  return { fired, failed };
}

async function fireSchedule({
  db,
  schedule,
  now,
}: {
  db: Database;
  schedule: Schedule;
  now: Date;
}): Promise<void> {
  const skillRows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, schedule.skillId))
    .limit(1);
  const skill = skillRows[0]
    ? canonicalizeStarterSkill(skillRows[0])
    : undefined;

  if (!skill || skill.archivedAt) {
    // Edge case from the spec: deleted/archived skill → disable gracefully
    // and record why, never throw the scheduler into a loop.
    await db
      .update(schedules)
      .set({
        enabled: false,
        claimedAt: null,
        claimedBy: null,
        lastError: skill
          ? "Skill is archived; schedule disabled."
          : "Skill no longer exists; schedule disabled.",
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, schedule.id));
    return;
  }

  const access = await checkSkillProviderAccess(
    db,
    schedule.userId,
    skill.mcpProviders,
  );
  if (!isSkillProviderAccessReady(access)) {
    const blockedProviders = [
      ...access.missingConnections,
      ...access.deniedAttestations,
      ...access.reconnectRequired,
      ...access.temporarilyUnavailable,
      ...access.executionUnavailable,
    ];
    throw new Error(
      `Provider access required before this scheduled skill can run: ${[...new Set(blockedProviders)].join(", ")}.`,
    );
  }

  let threadId = schedule.targetThreadId;
  if (!threadId) {
    const threadRows = await db
      .insert(chatThreads)
      .values({
        userId: schedule.userId,
        title: `Scheduled: ${skill.name}`,
        defaultModelId: skill.modelId,
        titleSource: "manual",
      })
      .returning({ id: chatThreads.id });
    threadId = threadRows[0]!.id;
    await db
      .update(schedules)
      .set({ targetThreadId: threadId, updatedAt: new Date() })
      .where(eq(schedules.id, schedule.id));
  }

  await createSkillRun({
    db,
    actorUserId: schedule.userId,
    skill,
    triggerType: "scheduled",
    scheduleId: schedule.id,
    threadId,
  });

  await advanceSchedule({ db, schedule, now, lastError: null });
}

async function advanceSchedule({
  db,
  schedule,
  now,
  lastError,
}: {
  db: Database;
  schedule: Schedule;
  now: Date;
  lastError: string | null;
}): Promise<void> {
  const anchor = new Date(
    Math.max(schedule.nextRunAt.getTime(), now.getTime()),
  );
  let nextRunAt: Date;
  try {
    nextRunAt = computeNextRunAt(schedule.cadence, schedule.timezone, anchor);
  } catch {
    // Unparseable cadence (should be blocked at create time): disable rather
    // than loop.
    await db
      .update(schedules)
      .set({
        enabled: false,
        claimedAt: null,
        claimedBy: null,
        lastError: `Invalid cadence "${schedule.cadence}"; schedule disabled.`,
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, schedule.id));
    return;
  }

  await db
    .update(schedules)
    .set({
      lastRunAt: schedule.nextRunAt,
      nextRunAt,
      claimedAt: null,
      claimedBy: null,
      lastError,
      updatedAt: new Date(),
    })
    .where(eq(schedules.id, schedule.id));
}

/**
 * Long-running scheduler loop hosted in the chat-run worker process — no new
 * service (plan constraint). Poll interval is deliberately coarse; schedules
 * are minute-granular.
 */
export async function runSchedulerLoop({
  db,
  workerId,
  pollIntervalMs = numberFromEnv("SCHEDULER_POLL_INTERVAL_MS") ??
    DEFAULT_POLL_INTERVAL_MS,
  signal,
}: {
  db: Database;
  workerId: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  while (!signal?.aborted) {
    try {
      await processDueSchedules({ db, workerId });
    } catch (err) {
      process.stderr.write(
        `[scheduler-pass-error] ${JSON.stringify({
          workerId,
          message: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
    }
    await delay(pollIntervalMs, signal);
  }
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    function onAbort() {
      clearTimeout(timeout);
      resolve();
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
