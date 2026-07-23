import { auditLog, getDb, schedules } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  computeNextRunAt,
  isValidCadence,
  isValidTimezone,
} from "@/lib/schedules/next-run";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Enable/disable or retune a schedule the caller owns. */
export async function PATCH(req: Request, { params }: RouteContext) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const patch = (body ?? {}) as Record<string, unknown>;

  const db = getDb();
  const rows = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.userId, sessionUser.id)))
    .limit(1);
  const schedule = rows[0];
  if (!schedule) {
    return NextResponse.json({ error: "schedule_not_found" }, { status: 404 });
  }

  const updates: Partial<typeof schedules.$inferInsert> = {
    updatedAt: new Date(),
  };

  if (typeof patch.enabled === "boolean") {
    updates.enabled = patch.enabled;
  }
  const cadence =
    typeof patch.cadence === "string" ? patch.cadence : schedule.cadence;
  const timezone =
    typeof patch.timezone === "string" ? patch.timezone : schedule.timezone;
  if (cadence !== schedule.cadence || timezone !== schedule.timezone) {
    if (!isValidCadence(cadence)) {
      return NextResponse.json(
        { error: "invalid_schedule", field: "cadence" },
        { status: 400 },
      );
    }
    if (!isValidTimezone(timezone)) {
      return NextResponse.json(
        { error: "invalid_schedule", field: "timezone" },
        { status: 400 },
      );
    }
    updates.cadence = cadence;
    updates.timezone = timezone;
    updates.nextRunAt = computeNextRunAt(cadence, timezone, new Date());
    updates.lastError = null;
  }

  const updated = await db
    .update(schedules)
    .set(updates)
    .where(eq(schedules.id, schedule.id))
    .returning();

  // #456: schedule changes alter what runs autonomously on the user's
  // behalf — create is already audited; update/delete now match.
  const updateAuditNow = new Date();
  await db.insert(auditLog).values({
    actorUserId: sessionUser.id,
    actionType: "schedule_update",
    status: "succeeded",
    provider: "ai-hub",
    toolName: "schedule_update",
    input: { scheduleId: schedule.id, skillId: schedule.skillId },
    metadata: { updates: Object.keys(updates) },
    startedAt: updateAuditNow,
    completedAt: updateAuditNow,
  });

  return NextResponse.json({ schedule: updated[0] });
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;

  const db = getDb();
  const rows = await db
    .delete(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.userId, sessionUser.id)))
    .returning({ id: schedules.id });
  if (!rows[0]) {
    return NextResponse.json({ error: "schedule_not_found" }, { status: 404 });
  }
  const deleteAuditNow = new Date();
  await db.insert(auditLog).values({
    actorUserId: sessionUser.id,
    actionType: "schedule_delete",
    status: "succeeded",
    provider: "ai-hub",
    toolName: "schedule_delete",
    input: { scheduleId: rows[0].id },
    startedAt: deleteAuditNow,
    completedAt: deleteAuditNow,
  });
  return NextResponse.json({ ok: true });
}
