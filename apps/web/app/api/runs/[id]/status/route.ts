import { AuthConfigError } from "@ai-workspace/auth";
import { getDb, runEvents, runs } from "@ai-workspace/db";
import { and, eq, max } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/runs/[id]/status — slim poll target for pending background runs
 * (#447). Returns just enough for the chat client to decide "still waiting"
 * vs "reload the thread now": run status, updatedAt, and the latest
 * run-event sequence. The 500ms pending-run poll hits this instead of
 * refetching the full thread (messages + events + artifact content) on
 * every tick.
 *
 * `role = 'user'`  → only runs the caller owns.
 * `role = 'admin'` → any run (read-side parity with the thread routes).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let sessionUser;
  try {
    sessionUser = await getSessionUser();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id: runId } = await params;
  if (!runId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();

  const runRows = await db
    .select({ id: runs.id, status: runs.status, updatedAt: runs.updatedAt })
    .from(runs)
    .where(and(eq(runs.id, runId), userScope(sessionUser, runs.userId)))
    .limit(1);
  const run = runRows[0];
  if (!run) {
    return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  }

  // (run_id, sequence) is index-covered — this is the cheap cursor read.
  const eventRows = await db
    .select({ latestEventSequence: max(runEvents.sequence) })
    .from(runEvents)
    .where(eq(runEvents.runId, run.id));

  return NextResponse.json({
    run: {
      id: run.id,
      status: run.status,
      updatedAt: run.updatedAt.toISOString(),
      latestEventSequence: eventRows[0]?.latestEventSequence ?? null,
    },
  });
}
