import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { parseSkillMarkdown } from "@/lib/skill-format";
import { auditSkillMutation, insertSkillWithUniqueSlug } from "@/lib/skills";

export const dynamic = "force-dynamic";

/**
 * Import a skill from a SKILL.md document (ADR 0002). Parses the
 * YAML-frontmatter + Markdown body into a skill row owned by the caller.
 * This is what makes the seeded Skill Creator's output directly usable.
 */
export async function POST(req: Request) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const markdown = (body as { markdown?: unknown })?.markdown;
  if (typeof markdown !== "string" || !markdown.trim()) {
    return NextResponse.json(
      { error: "missing_markdown", message: "Paste a SKILL.md document." },
      { status: 400 },
    );
  }
  if (markdown.length > 60_000) {
    return NextResponse.json(
      { error: "too_large", message: "That SKILL.md is too large." },
      { status: 413 },
    );
  }

  const parsed = parseSkillMarkdown(markdown);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_skill_md", message: parsed.error },
      { status: 400 },
    );
  }

  const db = getDb();
  const skill = await insertSkillWithUniqueSlug(db, {
    slug: parsed.skill.slug,
    name: parsed.skill.name,
    description: parsed.skill.description,
    ownerUserId: sessionUser.id,
    systemPrompt: parsed.skill.systemPrompt,
    modelId: parsed.skill.modelId,
    mcpProviders: parsed.skill.mcpProviders,
  });

  await auditSkillMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "skill_create",
    skillId: skill.id,
    skillSlug: skill.slug,
    metadata: { source: "skill_md_import", modelId: skill.modelId },
  });

  return NextResponse.json(
    { skill, warnings: parsed.skill.warnings },
    { status: 201 },
  );
}
