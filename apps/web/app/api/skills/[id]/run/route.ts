import { getDb, skills } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { checkRateLimit, requestLimitConfig } from "@/lib/request-limits";
import { checkSkillProviderAccess, createSkillRun } from "@/lib/skills";
import { canActorRunSkill } from "@/lib/shares";

export const dynamic = "force-dynamic";

/**
 * Run a skill now. Provider access is gated *before* anything is enqueued
 * (FR-004): the caller gets an actionable 409 naming exactly which providers
 * need connecting or approval. Execution itself rides the shared chat-run
 * worker pipeline.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  // Skill runs can do tool work — give them the same reduced allowance the
  // Developer Briefing workflow uses (one third of the chat budget).
  const baseLimits = requestLimitConfig();
  const rate = checkRateLimit(`skill-run:${sessionUser.id}`, {
    ...baseLimits,
    maxRequests: Math.max(1, Math.floor(baseLimits.maxRequests / 3)),
  });
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds) },
      },
    );
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  const skill = rows[0];
  if (!skill || !(await canActorRunSkill(db, skill, sessionUser))) {
    return NextResponse.json({ error: "skill_not_found" }, { status: 404 });
  }

  const access = await checkSkillProviderAccess(
    db,
    sessionUser.id,
    skill.mcpProviders,
  );
  if (
    access.missingConnections.length > 0 ||
    access.deniedAttestations.length > 0
  ) {
    const parts: string[] = [];
    if (access.missingConnections.length > 0) {
      parts.push(
        `connect ${access.missingConnections.join(", ")} in Settings`,
      );
    }
    if (access.deniedAttestations.length > 0) {
      parts.push(
        `approve tool access for ${access.deniedAttestations.join(", ")}`,
      );
    }
    return NextResponse.json(
      {
        error: "provider_access_required",
        message: `This skill needs tools you haven't enabled yet — ${parts.join(" and ")}.`,
        missingConnections: access.missingConnections,
        deniedAttestations: access.deniedAttestations,
      },
      { status: 409 },
    );
  }

  const result = await createSkillRun({
    db,
    actorUserId: sessionUser.id,
    skill,
    triggerType: "skill",
  });

  return NextResponse.json(
    { runId: result.runId, threadId: result.threadId },
    { status: 202 },
  );
}
