import { getDb, skills } from "@ai-workspace/db";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { enabledModelsForPurpose } from "@/lib/model-registry";
import {
  auditSkillMutation,
  insertSkillWithUniqueSlug,
  parseSkillInput,
} from "@/lib/skills";
import { listSkillsSharedWith } from "@/lib/shares";

export const dynamic = "force-dynamic";

/** List the catalog: my skills plus starters (visible to everyone). */
export async function GET() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(
      and(
        isNull(skills.archivedAt),
        or(eq(skills.ownerUserId, sessionUser.id), eq(skills.isStarter, true)),
      ),
    )
    .orderBy(desc(skills.updatedAt));

  const sharedRaw = await listSkillsSharedWith(db, sessionUser.id);
  const visibleIds = new Set(rows.map((s) => s.id));
  const all = [
    ...rows.map((skill) => ({ skill, shared: false })),
    ...sharedRaw
      .filter((s) => !visibleIds.has(s.id))
      .map((skill) => ({ skill, shared: true })),
  ];

  return NextResponse.json({
    skills: all.map(({ skill, shared }) => ({
      sharedWithMe: shared,
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      modelId: skill.modelId,
      mcpProviders: skill.mcpProviders,
      isStarter: skill.isStarter,
      isOwner: skill.ownerUserId === sessionUser.id,
      clonedFromSkillId: skill.clonedFromSkillId,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    })),
  });
}

/** Create a skill owned by the caller. */
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

  const db = getDb();
  const parsed = parseSkillInput(body, {
    enabledModelIds: new Set(await enabledModelsForPurpose(db, "chat")),
  });
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_skill", field: parsed.error.field, message: parsed.error.message },
      { status: 400 },
    );
  }

  const skill = await insertSkillWithUniqueSlug(db, {
    name: parsed.input.name,
    description: parsed.input.description,
    ownerUserId: sessionUser.id,
    systemPrompt: parsed.input.systemPrompt,
    modelId: parsed.input.modelId,
    mcpProviders: parsed.input.mcpProviders,
  });

  await auditSkillMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "skill_create",
    skillId: skill.id,
    skillSlug: skill.slug,
    metadata: { modelId: skill.modelId, mcpProviders: skill.mcpProviders },
  });

  return NextResponse.json({ skill }, { status: 201 });
}
