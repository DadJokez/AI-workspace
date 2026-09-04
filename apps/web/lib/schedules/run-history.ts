import type { RunBudgetDimension } from "@ai-workspace/agent";
import { type Database, runs } from "@ai-workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { budgetTruncation } from "@/lib/run-budget-policy";
import {
  IN_FLIGHT_RUN_STATUSES,
  type ScheduleFire,
  scheduleFireFromInputs,
} from "@/lib/run-status-presentation";

export const SCHEDULE_RUN_HISTORY_LIMIT = 5;

export interface ScheduleRunHistoryEntry {
  id: string;
  status: string;
  scheduleFire: ScheduleFire | null;
  threadId: string | null;
  error: string | null;
  truncatedBy: RunBudgetDimension | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * The last N runs a schedule produced, newest first (#780). Scoped to the
 * requesting user: a schedule belongs to exactly one user, but every run
 * read carries the `runs.user_id` predicate regardless (#827/#846) so a
 * mis-joined schedule id can never widen into another user's history. One
 * query per schedule — a skill has a handful at most, and a per-schedule
 * cap across many schedules would need a window function for no gain.
 */
export async function listScheduleRunHistory({
  db,
  userId,
  scheduleId,
  limit = SCHEDULE_RUN_HISTORY_LIMIT,
}: {
  db: Database;
  userId: string;
  scheduleId: string;
  limit?: number;
}): Promise<ScheduleRunHistoryEntry[]> {
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      threadId: runs.threadId,
      inputs: runs.inputs,
      outputs: runs.outputs,
      error: runs.error,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
    })
    .from(runs)
    .where(and(eq(runs.scheduleId, scheduleId), eq(runs.userId, userId)))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    scheduleFire: scheduleFireFromInputs(row.inputs),
    threadId: row.threadId,
    error: row.error,
    truncatedBy: budgetTruncation(row.outputs),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }));
}

/**
 * Double-fire guard shared by "Run now" and the cadence tick: true while a
 * run for the schedule is queued or running. Stuck rows resolve themselves —
 * the worker fails a run once its attempt ceiling is reached — so the guard
 * cannot wedge a schedule permanently.
 */
export async function hasInFlightScheduleRun({
  db,
  userId,
  scheduleId,
}: {
  db: Database;
  userId: string;
  scheduleId: string;
}): Promise<boolean> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.scheduleId, scheduleId),
        eq(runs.userId, userId),
        inArray(runs.status, [...IN_FLIGHT_RUN_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
