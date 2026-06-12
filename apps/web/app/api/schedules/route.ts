import { getDb, schedules, skills } from "@ai-workspace/db";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  computeNextRunAt,
  isValidCadence,
  isValidTimezone,
} from "@/lib/schedules/next-run";
import { auditSkillMutation, canRunSkill } from "@/lib/skills";

export const dynamic = "force-dynamic";

/** List the caller's schedules with their skill names. */
export async function GET() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: schedules.id,
      skillId: schedules.skillId,
      skillName: skills.name,
      cadence: schedules.cadence,
      timezone: schedules.timezone,
      targetThreadId: schedules.targetThreadId,
      enabled: schedules.enabled,
      lastRunAt: schedules.lastRunAt,
      nextRunAt: schedules.nextRunAt,
      lastError: schedules.lastError,
      createdAt: schedules.createdAt,
    })
    .from(schedules)
    .leftJoin(skills, eq(schedules.skillId, skills.id))
    .where(eq(schedules.userId, sessionUser.id))
    .orderBy(desc(schedules.createdAt));

  return NextResponse.json({ schedules: rows });
}

/** Create a schedule for a skill the caller can run. */
export async function POST(req: Request) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { skillId, cadence, timezone } = body as Record<string, unknown>;

  if (typeof skillId !== "string" || !skillId) {
    return NextResponse.json(
      { error: "invalid_schedule", field: "skillId" },
      { status: 400 },
    );
  }
  if (typeof cadence !== "string" || !isValidCadence(cadence)) {
    return NextResponse.json(
      {
        error: "invalid_schedule",
        field: "cadence",
        message:
          'Cadence must be one of the supported shapes, e.g. "0 8 * * *", "0 8 * * MON", "0 9 * * MON-FRI", "0 7 15 * *".',
      },
      { status: 400 },
    );
  }
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: "invalid_schedule", field: "timezone" },
      { status: 400 },
    );
  }

  const db = getDb();
  const skillRows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);
  const skill = skillRows[0];
  if (!skill || !canRunSkill(skill, sessionUser)) {
    return NextResponse.json({ error: "skill_not_found" }, { status: 404 });
  }

  const nextRunAt = computeNextRunAt(cadence, timezone, new Date());
  const rows = await db
    .insert(schedules)
    .values({
      userId: sessionUser.id,
      skillId: skill.id,
      cadence,
      timezone,
      nextRunAt,
    })
    .returning();

  await auditSkillMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "skill_update",
    skillId: skill.id,
    skillSlug: skill.slug,
    metadata: {
      schedule: "created",
      scheduleId: rows[0]!.id,
      cadence,
      timezone,
      nextRunAt: nextRunAt.toISOString(),
    },
  });

  return NextResponse.json({ schedule: rows[0] }, { status: 201 });
}
