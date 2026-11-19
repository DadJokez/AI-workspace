import { auditLog, getDb, runs, runEvents, users } from "@ai-workspace/db";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { recordAdminUserDataAccess } from "@/lib/admin-data-access";
import { parseAdminReason } from "@/lib/admin-reason";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { redactTracePayload } from "@/lib/tool-redaction";
import { expandProviderContextSnapshotOutput } from "@/lib/run-trace";
import { loadThreadBranchLineage } from "@/lib/thread-branches";

export const dynamic = "force-dynamic";

const TRACE_ACCESS_WINDOW_MS = 5 * 60 * 1_000;

/**
 * GET /api/admin/runs/[id]/trace?reason=… — the Run Inspector's redacted
 * trace. Admin only. For a run the admin owns, no reason is needed. For
 * another user's run, `reason` (1-500 characters) is required, and an
 * `admin.user_data_access` row naming the run's owner and the run is written
 * before the trace is returned; without a reason the answer is a 400 that
 * carries nothing about the run.
 */
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
      threadId: runs.threadId,
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
  const crossUser = run.userId !== auth.user.id;
  if (crossUser) {
    const reason = parseAdminReason(
      new URL(request.url).searchParams.get("reason"),
    );
    if (!reason) {
      return NextResponse.json(
        {
          error: "access_reason_required",
          message:
            "This run belongs to another user. Give a reason (up to 500 characters) to open it; the reason is recorded in the audit log.",
        },
        { status: 400 },
      );
    }
    await recordAdminUserDataAccess({
      db,
      actor: auth.user,
      access: {
        targetUserId: run.userId,
        resourceType: "run",
        resourceId: run.id,
        surface: "run_inspector",
        reason,
        runId: run.id,
      },
      now,
    });
  }
  await auditTraceAccess({
    db,
    actorUserId: auth.user.id,
    runId: run.id,
    now,
  });

  const [eventRows, auditRows, lineage] = await Promise.all([
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
        policyDecision: auditLog.policyDecision,
        metadata: auditLog.metadata,
        startedAt: auditLog.startedAt,
        completedAt: auditLog.completedAt,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.runId, run.id))
      .orderBy(desc(auditLog.createdAt))
      .limit(250),
    run.threadId
      ? // The lineage as the run's owner sees it: which branch sources are
        // still available is decided by the owner's access, not the admin's.
        loadThreadBranchLineage({
          db,
          threadId: run.threadId,
          actor: { id: run.userId, role: "user" },
        })
      : Promise.resolve(null),
  ]);

  const trace = {
    schema: "run-inspector.v1",
    generatedAt: now.toISOString(),
    run: redactTracePayload({
      ...run,
      lineage,
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

async function auditTraceAccess({
  db,
  actorUserId,
  runId,
  now,
}: {
  db: ReturnType<typeof getDb>;
  actorUserId: string;
  runId: string;
  now: Date;
}) {
  const recent = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorUserId, actorUserId),
        eq(auditLog.runId, runId),
        eq(auditLog.actionType, "run_trace_viewed"),
        gte(
          auditLog.createdAt,
          new Date(now.getTime() - TRACE_ACCESS_WINDOW_MS),
        ),
      ),
    )
    .limit(1);
  if (recent.length > 0) return;

  await db.insert(auditLog).values({
    actorUserId,
    runId,
    actionType: "run_trace_viewed",
    status: "succeeded",
    metadata: {
      surface: "run_inspector",
      schema: "run-inspector.v1",
    },
    startedAt: now,
    completedAt: now,
    createdAt: now,
  });
}
