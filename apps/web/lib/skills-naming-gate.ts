import { skills, type Database } from "@ai-workspace/db";
import { isNull } from "drizzle-orm";
import type { SessionUser } from "@ai-workspace/auth";
import {
  findSkillNamingConflict,
  lintSkillDescription,
} from "@/lib/skill-naming";

export interface SkillNamingGateError {
  status: number;
  error: string;
  field: "name" | "description";
  message: string;
}

/**
 * The #412 create/update gate: impersonation + reserved-prefix checks
 * against the full live catalog (10² scale — one indexed select), plus
 * the description lint. Returns null when clean.
 */
export async function evaluateSkillNamingGate(
  db: Database,
  {
    name,
    description,
    actor,
    selfSlug,
  }: {
    name: string;
    description: string | null | undefined;
    actor: Pick<SessionUser, "id" | "role">;
    selfSlug?: string | null;
  },
): Promise<SkillNamingGateError | null> {
  const existing = await db
    .select({
      slug: skills.slug,
      name: skills.name,
      isStarter: skills.isStarter,
      ownerUserId: skills.ownerUserId,
    })
    .from(skills)
    .where(isNull(skills.archivedAt));

  const conflict = findSkillNamingConflict({
    name,
    existing,
    actorUserId: actor.id,
    actorIsAdmin: actor.role === "admin",
    selfSlug,
  });
  if (conflict) {
    return {
      status: 422,
      error: "skill_name_conflict",
      field: "name",
      message:
        conflict.reason === "reserved_prefix"
          ? `"${conflict.token}" is a reserved prefix.`
          : conflict.reason === "impersonates_starter"
            ? `This name is too close to the built-in "${conflict.conflictingSlug}" skill — pick a distinct name.`
            : `This name is too close to the existing "${conflict.conflictingSlug}" skill — pick a distinct name.`,
    };
  }

  if (typeof description === "string" && description.trim().length > 0) {
    const lint = lintSkillDescription(description);
    if (!lint.ok) {
      return {
        status: 422,
        error: "skill_description_lint",
        field: "description",
        message: lint.message,
      };
    }
  }

  return null;
}
