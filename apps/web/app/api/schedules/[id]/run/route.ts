import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { runScheduleNow } from "@/lib/schedules/scheduler";
import {
  providerAccessRequiredBody,
  skillRunRateLimitResponse,
} from "@/lib/skill-run-gates";

export const dynamic = "force-dynamic";

/**
 * #780 "Run now": fire a schedule the caller owns off-cycle, right now,
 * without editing it. Same gates as the skill Run button (shared rate-limit
 * bucket, provider access before anything is enqueued); the fire itself is
 * the scheduler's own path, so the run is a scheduled run in every respect
 * except its `scheduleFire: "manual"` marker.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;
  const db = getDb();

  const limited = await skillRunRateLimitResponse({
    db,
    userId: sessionUser.id,
    route: `/api/schedules/${id}/run`,
  });
  if (limited) return limited;

  const result = await runScheduleNow({
    db,
    actor: sessionUser,
    scheduleId: id,
  });
  if (!result.ok) {
    if (result.error === "provider_access_required") {
      return NextResponse.json(providerAccessRequiredBody(result.access), {
        status: 409,
      });
    }
    return NextResponse.json(
      {
        error: result.error,
        ...("message" in result ? { message: result.message } : {}),
      },
      { status: result.status },
    );
  }

  return NextResponse.json(
    { runId: result.runId, threadId: result.threadId },
    { status: 202 },
  );
}
