import { auditLog, getDb, runs, runEvents, users } from "@ai-workspace/db";
import { asc, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { redactTracePayload } from "@/lib/tool-redaction";
import { expandProviderContextSnapshotOutput } from "@/lib/run-trace";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const db = getDb();
  const runRows = await db
    .select({
      id: runs.id,
      userId: runs.userId,
      skillSlug: runs.skillSlug,
      status: runs.status,
      triggerType: runs.triggerType,
      runtime: runs.runtime,
      modelId: runs.modelId,
      inputs: runs.inputs,
      outputs: runs.outputs,
      error: runs.error,
      attemptCount: runs.attemptCount,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
      actorEmail: users.email,
      actorName: users.displayName,
    })
    .from(runs)
    .leftJoin(users, eq(runs.userId, users.id))
    .where(eq(runs.id, id))
    .limit(1);

  const run = runRows[0];
  if (!run) {
    return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  }

  const now = new Date();
  await auditAdminDataAccess({
    db,
    actor: auth.user,
    access: {
      targetUserId: run.userId,
      resourceType: "run",
      resourceId: run.id,
      surface: "run_inspector",
      justification: adminDataAccessJustification(request),
      runId: run.id,
    },
    now,
  });

  const [eventRows, auditRows] = await Promise.all([
    db
      .select({
        id: runEvents.id,
        sequence: runEvents.sequence,
        eventType: runEvents.eventType,
        status: runEvents.status,
        label: runEvents.label,
        provider: runEvents.provider,
        toolName: runEvents.toolName,
        toolCallId: runEvents.toolCallId,
        input: runEvents.input,
        output: runEvents.output,
        error: runEvents.error,
        metadata: runEvents.metadata,
        occurredAt: runEvents.occurredAt,
      })
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(asc(runEvents.sequence), asc(runEvents.occurredAt))
      .limit(1_000),
    db
      .select({
        id: auditLog.id,
        actionType: auditLog.actionType,
        status: auditLog.status,
        provider: auditLog.provider,
        toolName: auditLog.toolName,
        toolCallId: auditLog.toolCallId,
        input: auditLog.input,
        output: auditLog.output,
        error: auditLog.error,
        metadata: auditLog.metadata,
        startedAt: auditLog.startedAt,
        completedAt: auditLog.completedAt,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.runId, run.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(250),
  ]);

  const trace = {
    schema: "run-inspector.v1",
    generatedAt: now.toISOString(),
    run: redactTracePayload({
      ...run,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    }),
    events: eventRows.map((event) =>
      redactTracePayload({
        ...event,
        // v2 traces store deduplicated payloads (#386); the Inspector and
        // its download see the reconstructed per-request timeline either way.
        output:
          event.eventType === "provider_context_snapshot"
            ? expandProviderContextSnapshotOutput(event.output)
            : event.output,
        occurredAt: event.occurredAt.toISOString(),
      }),
    ),
    auditEvents: auditRows.map((event) =>
      redactTracePayload({
        ...event,
        startedAt: event.startedAt?.toISOString() ?? null,
        completedAt: event.completedAt?.toISOString() ?? null,
        createdAt: event.createdAt.toISOString(),
      }),
    ),
  };

  return NextResponse.json({ trace });
}
