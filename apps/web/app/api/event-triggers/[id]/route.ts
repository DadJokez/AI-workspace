import { auditLog, eventTriggers, getDb } from "@ai-workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, context: RouteContext) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("enabled" in body) ||
    typeof (body as { enabled?: unknown }).enabled !== "boolean"
  ) {
    return NextResponse.json(
      { error: "invalid_event_trigger", field: "enabled" },
      { status: 400 },
    );
  }

  const { id } = await context.params;
  const enabled = (body as { enabled: boolean }).enabled;
  const db = getDb();
  const now = new Date();
  const rows = await db
    .update(eventTriggers)
    .set({ enabled, lastError: enabled ? null : undefined, updatedAt: now })
    .where(
      and(
        eq(eventTriggers.id, id),
        eq(eventTriggers.userId, sessionUser.id),
        isNull(eventTriggers.deletedAt),
      ),
    )
    .returning();
  const trigger = rows[0];
  if (!trigger) {
    return NextResponse.json({ error: "trigger_not_found" }, { status: 404 });
  }

  await db.insert(auditLog).values({
    actorUserId: sessionUser.id,
    actionType: "event_trigger_update",
    status: "succeeded",
    provider: "github",
    toolName: trigger.eventType,
    input: { triggerId: trigger.id },
    metadata: { enabled },
    startedAt: now,
    completedAt: now,
  });

  return NextResponse.json({ trigger });
}

export async function DELETE(_req: Request, context: RouteContext) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const { id } = await context.params;
  const db = getDb();
  const now = new Date();
  const rows = await db
    .update(eventTriggers)
    .set({ enabled: false, deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(eventTriggers.id, id),
        eq(eventTriggers.userId, sessionUser.id),
        isNull(eventTriggers.deletedAt),
      ),
    )
    .returning();
  const trigger = rows[0];
  if (!trigger) {
    return NextResponse.json({ error: "trigger_not_found" }, { status: 404 });
  }

  await db.insert(auditLog).values({
    actorUserId: sessionUser.id,
    actionType: "event_trigger_delete",
    status: "succeeded",
    provider: "github",
    toolName: trigger.eventType,
    input: { triggerId: trigger.id },
    startedAt: now,
    completedAt: now,
  });

  return NextResponse.json({ ok: true });
}
