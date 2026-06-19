import type { SessionUser } from "@ai-workspace/auth";
import {
  type Database,
  type Skill,
  skills as skillsTable,
} from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { canActorRunSkill } from "@/lib/shares";
import { checkSkillProviderAccess } from "@/lib/skills";
import { canonicalizeStarterSkill } from "@/lib/starter-skills";

export interface ActivatedSkillRequest {
  id?: string;
  slug?: string;
  source?: string;
  args?: string;
}

export interface ActivatedSkillForChat {
  skill: Skill;
  args: string;
}

export type ResolveActivatedSkillResult =
  | { ok: true; activatedSkill: ActivatedSkillForChat | null }
  | { ok: false; status: number; error: string; message: string };

interface ResolveActivatedSkillDeps {
  canRunSkill?: typeof canActorRunSkill;
  checkProviderAccess?: typeof checkSkillProviderAccess;
}

export async function resolveActivatedSkillForChat({
  db,
  actor,
  activatedSkills,
  deps = {},
}: {
  db: Database;
  actor: SessionUser;
  activatedSkills: ActivatedSkillRequest[] | undefined;
  deps?: ResolveActivatedSkillDeps;
}): Promise<ResolveActivatedSkillResult> {
  if (!activatedSkills || activatedSkills.length === 0) {
    return { ok: true, activatedSkill: null };
  }
  if (!Array.isArray(activatedSkills) || activatedSkills.length > 1) {
    return {
      ok: false,
      status: 400,
      error: "invalid_activated_skills",
      message: "Activate one skill per chat message.",
    };
  }

  const request = activatedSkills[0]!;
  if (request.source && request.source !== "explicit") {
    return {
      ok: false,
      status: 400,
      error: "invalid_activated_skill_source",
      message: "Only explicitly selected skills can be activated from chat.",
    };
  }

  const id = typeof request.id === "string" ? request.id.trim() : "";
  const slug = typeof request.slug === "string" ? request.slug.trim() : "";
  if (!id && !slug) {
    return {
      ok: false,
      status: 400,
      error: "invalid_activated_skill",
      message: "The selected skill was missing an id or slug.",
    };
  }

  const rows = await db
    .select()
    .from(skillsTable)
    .where(id ? eq(skillsTable.id, id) : eq(skillsTable.slug, slug))
    .limit(1);
  const skill = rows[0] ? canonicalizeStarterSkill(rows[0]) : undefined;
  const canRunSkill = deps.canRunSkill ?? canActorRunSkill;
  if (!skill || !(await canRunSkill(db, skill, actor))) {
    return {
      ok: false,
      status: 404,
      error: "skill_not_found",
      message: "That skill is not available in your workspace.",
    };
  }

  const checkProviderAccess = deps.checkProviderAccess ?? checkSkillProviderAccess;
  const access = await checkProviderAccess(db, actor.id, skill.mcpProviders);
  const executionUnavailable = access.executionUnavailable ?? [];
  if (
    access.missingConnections.length > 0 ||
    access.deniedAttestations.length > 0 ||
    executionUnavailable.length > 0
  ) {
    const parts = [
      access.missingConnections.length
        ? `connect ${access.missingConnections.join(", ")}`
        : "",
      access.deniedAttestations.length
        ? `approve ${access.deniedAttestations.join(", ")}`
        : "",
      executionUnavailable.length
        ? `wait for chat execution to be enabled for ${executionUnavailable.join(", ")}`
        : "",
    ].filter(Boolean);
    return {
      ok: false,
      status: 409,
      error: "skill_provider_unavailable",
      message: `This skill needs tools you haven't enabled yet — ${parts.join(" and ")}.`,
    };
  }

  return {
    ok: true,
    activatedSkill: {
      skill,
      args: typeof request.args === "string" ? request.args.trim() : "",
    },
  };
}
