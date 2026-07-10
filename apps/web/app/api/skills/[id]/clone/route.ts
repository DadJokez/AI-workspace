import { getDb, skills } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  auditSkillMutation,
  insertSkillWithUniqueSlug,
  slugifySkillName,
} from "@/lib/skills";
import { canActorAccessSkill } from "@/lib/shares";
import { canonicalizeStarterSkill } from "@/lib/starter-skills";

export const dynamic = "force-dynamic";

/**
 * Clone any visible skill into a private editable copy with provenance.
 * Cloning is always allowed where viewing is (starters, own skills, and —
 * once shares land — skills shared with you).
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

  const db = getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  const storedSource = rows[0];
  if (
    !storedSource ||
    !(await canActorAccessSkill(db, storedSource, sessionUser))
  ) {
    return NextResponse.json({ error: "skill_not_found" }, { status: 404 });
  }
  if (storedSource.archivedAt) {
    return NextResponse.json({ error: "skill_archived" }, { status: 409 });
  }
  const source = canonicalizeStarterSkill(storedSource);

  const clone = await insertSkillWithUniqueSlug(db, {
    slug: slugifySkillName(source.name),
    name:
      source.ownerUserId === sessionUser.id
        ? `${source.name} (copy)`
        : source.name,
    description: source.description,
    ownerUserId: sessionUser.id,
    systemPrompt: source.systemPrompt,
    modelId: source.modelId,
    mcpProviders: source.mcpProviders,
    clonedFromSkillId: source.id,
    isStarter: false,
  });

  await auditSkillMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "skill_clone",
    skillId: clone.id,
    skillSlug: clone.slug,
    metadata: { clonedFromSkillId: source.id, clonedFromSlug: source.slug },
  });

  return NextResponse.json({ skill: clone }, { status: 201 });
}
