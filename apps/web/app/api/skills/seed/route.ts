import { getDb, skills } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { auditSkillMutation } from "@/lib/skills";
import { STARTER_SKILLS } from "@/lib/starter-skills";

export const dynamic = "force-dynamic";


/**
 * Idempotent admin action: seed the starter skills (T207). Existing slugs
 * are left untouched so re-running is always safe.
 */
export async function POST() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (sessionUser.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = getDb();
  const created: string[] = [];
  const skipped: string[] = [];

  for (const starter of STARTER_SKILLS) {
    const existing = await db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.slug, starter.slug))
      .limit(1);
    if (existing[0]) {
      skipped.push(starter.slug);
      continue;
    }

    const rows = await db
      .insert(skills)
      .values({
        slug: starter.slug,
        name: starter.name,
        description: starter.description,
        ownerUserId: sessionUser.id,
        systemPrompt: starter.systemPrompt,
        modelId: starter.modelId,
        mcpProviders: starter.mcpProviders,
        isStarter: true,
      })
      .onConflictDoNothing({ target: skills.slug })
      .returning({ id: skills.id, slug: skills.slug });

    if (rows[0]) {
      created.push(rows[0].slug);
      await auditSkillMutation({
        db,
        actorUserId: sessionUser.id,
        actionType: "skill_seed",
        skillId: rows[0].id,
        skillSlug: rows[0].slug,
      });
    } else {
      skipped.push(starter.slug);
    }
  }

  return NextResponse.json({ created, skipped });
}
