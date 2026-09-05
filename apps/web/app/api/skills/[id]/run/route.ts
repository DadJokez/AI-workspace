import { getDb, skills } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  providerAccessRequiredBody,
  skillRunRateLimitResponse,
} from "@/lib/skill-run-gates";
import {
  checkSkillProviderAccess,
  createSkillRun,
  isSkillProviderAccessReady,
} from "@/lib/skills";
import { canActorRunSkill } from "@/lib/shares";
import { canonicalizeStarterSkill } from "@/lib/starter-skills";

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
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;
  const db = getDb();

  const limited = await skillRunRateLimitResponse({
    db,
    userId: sessionUser.id,
    route: `/api/skills/${id}/run`,
  });
  if (limited) return limited;

  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  const skill = rows[0] ? canonicalizeStarterSkill(rows[0]) : undefined;
  if (!skill || !(await canActorRunSkill(db, skill, sessionUser))) {
    return NextResponse.json({ error: "skill_not_found" }, { status: 404 });
  }

  const access = await checkSkillProviderAccess(
    db,
    sessionUser.id,
    skill.mcpProviders,
  );
  if (!isSkillProviderAccessReady(access)) {
    return NextResponse.json(providerAccessRequiredBody(access), {
      status: 409,
    });
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
