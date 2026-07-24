import { getDb, skills, type Skill } from "@ai-workspace/db";
import { PLATFORM_MODEL_OVERRIDE_ID } from "@ai-workspace/agent";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { SessionUser } from "@ai-workspace/auth";
import { requireSession } from "@/lib/auth/requireSession";
import { enabledModelsForPurpose } from "@/lib/model-registry";
import { auditSkillMutation, parseSkillInput } from "@/lib/skills";
import { evaluateSkillNamingGate } from "@/lib/skills-naming-gate";
import { canActorAccessSkill } from "@/lib/shares";
import { canonicalizeStarterSkill } from "@/lib/starter-skills";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function loadSkill(id: string): Promise<Skill | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function notFound() {
  return NextResponse.json({ error: "skill_not_found" }, { status: 404 });
}

function forbiddenUnlessOwner(skill: Skill, sessionUser: SessionUser) {
  if (skill.ownerUserId !== sessionUser.id) {
    return NextResponse.json(
      {
        error: "not_owner",
        message: "Only the skill's owner can modify it. Clone it instead.",
      },
      { status: 403 },
    );
  }
  return null;
}

export async function GET(_req: Request, context: RouteContext) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await context.params;
  const skill = await loadSkill(id);
  if (!skill || !(await canActorAccessSkill(getDb(), skill, sessionUser))) {
    return notFound();
  }
  const effectiveSkill = canonicalizeStarterSkill(skill);
  return NextResponse.json({
    skill: {
      ...effectiveSkill,
      isOwner: effectiveSkill.ownerUserId === sessionUser.id,
    },
  });
}

export async function PATCH(req: Request, context: RouteContext) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await context.params;
  const skill = await loadSkill(id);
  if (!skill || !(await canActorAccessSkill(getDb(), skill, sessionUser))) {
    return notFound();
  }
  const forbidden = forbiddenUnlessOwner(skill, sessionUser);
  if (forbidden) return forbidden;
  if (skill.archivedAt) {
    return NextResponse.json({ error: "skill_archived" }, { status: 409 });
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

  // #412: renames get the same impersonation gate as creation; the skill's
  // own slug is exempt so saving without a rename never conflicts.
  const naming = await evaluateSkillNamingGate(db, {
    name: parsed.input.name,
    description: parsed.input.description,
    actor: sessionUser,
    selfSlug: skill.slug,
  });
  if (naming) {
    return NextResponse.json(
      { error: naming.error, field: naming.field, message: naming.message },
      { status: naming.status },
    );
  }

  // A platform override changes execution without destroying the skill's
  // persisted preference, so removing the override restores prior behavior.
  const storedModelId = PLATFORM_MODEL_OVERRIDE_ID
    ? skill.modelId
    : parsed.input.modelId;

  const rows = await db
    .update(skills)
    .set({
      name: parsed.input.name,
      description: parsed.input.description,
      systemPrompt: parsed.input.systemPrompt,
      modelId: storedModelId,
      mcpProviders: parsed.input.mcpProviders,
      updatedAt: new Date(),
    })
    .where(eq(skills.id, skill.id))
    .returning();

  await auditSkillMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "skill_update",
    skillId: skill.id,
    skillSlug: skill.slug,
    metadata: { modelId: storedModelId },
  });

  return NextResponse.json({ skill: rows[0] });
}

/** Archive (soft delete): the skill disappears from catalogs; history persists. */
export async function DELETE(_req: Request, context: RouteContext) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await context.params;
  const skill = await loadSkill(id);
  if (!skill || !(await canActorAccessSkill(getDb(), skill, sessionUser))) {
    return notFound();
  }
  const forbidden = forbiddenUnlessOwner(skill, sessionUser);
  if (forbidden) return forbidden;

  const db = getDb();
  const now = new Date();
  await db
    .update(skills)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(skills.id, skill.id));

  await auditSkillMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "skill_archive",
    skillId: skill.id,
    skillSlug: skill.slug,
  });

  return NextResponse.json({ ok: true });
}
