import { getDb, skills } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { canActorAccessSkill } from "@/lib/shares";
import { serializeSkillToMarkdown } from "@/lib/skill-format";
import { canonicalizeStarterSkill } from "@/lib/starter-skills";

export const dynamic = "force-dynamic";

/**
 * Export a skill as a portable SKILL.md document (ADR 0002) — for git
 * versioning, sharing as a file, or moving between environments. Any user who
 * can view the skill can export it.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;

  const db = getDb();
  const rows = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
  const storedSkill = rows[0];
  if (
    !storedSkill ||
    !(await canActorAccessSkill(db, storedSkill, sessionUser))
  ) {
    return NextResponse.json({ error: "skill_not_found" }, { status: 404 });
  }
  const skill = canonicalizeStarterSkill(storedSkill);

  const markdown = serializeSkillToMarkdown({
    slug: skill.slug,
    description: skill.description,
    systemPrompt: skill.systemPrompt,
    modelId: skill.modelId,
    mcpProviders: skill.mcpProviders,
  });

  return new NextResponse(markdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${skill.slug}.SKILL.md"`,
      "cache-control": "no-store",
    },
  });
}
