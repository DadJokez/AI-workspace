import type { SessionUser } from "@ai-workspace/auth";
import {
  apps,
  auditLog,
  type Database,
  type Share,
  shares,
  type Skill,
  skills,
  users,
} from "@ai-workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { canViewSkill } from "@/lib/skills";

export type ShareSubjectType = "skill" | "app";
export type AppShareRole = "viewer" | "editor";

export function parseAppShareRole(value: unknown): AppShareRole {
  return value === "editor" ? "editor" : "viewer";
}

async function loadShareSubjectOwnerUserId(
  db: Database,
  share: Pick<Share, "subjectType" | "subjectId">,
): Promise<string | null> {
  if (share.subjectType === "app") {
    const rows = await db
      .select({ ownerUserId: apps.ownerUserId })
      .from(apps)
      .where(eq(apps.id, share.subjectId))
      .limit(1);
    return rows[0]?.ownerUserId ?? null;
  }

  if (share.subjectType === "skill") {
    const rows = await db
      .select({ ownerUserId: skills.ownerUserId })
      .from(skills)
      .where(eq(skills.id, share.subjectId))
      .limit(1);
    return rows[0]?.ownerUserId ?? null;
  }

  return null;
}

async function canActorManageShare(
  db: Database,
  share: Pick<Share, "subjectType" | "subjectId" | "grantedByUserId">,
  actor: SessionUser,
): Promise<boolean> {
  if (share.grantedByUserId === actor.id || actor.role === "admin") return true;
  return (await loadShareSubjectOwnerUserId(db, share)) === actor.id;
}

/**
 * A share grants visibility + run/open + clone — never edit and never the
 * grantor's credentials (FR-010/FR-011). Execution always re-gates on the
 * recipient's own connections and attestations.
 */
export async function hasActiveShare(
  db: Database,
  subjectType: ShareSubjectType,
  subjectId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: shares.id })
    .from(shares)
    .where(
      and(
        eq(shares.subjectType, subjectType),
        eq(shares.subjectId, subjectId),
        eq(shares.grantedToUserId, userId),
        isNull(shares.revokedAt),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

export async function getActiveShareRole(
  db: Database,
  subjectType: ShareSubjectType,
  subjectId: string,
  userId: string,
): Promise<AppShareRole | null> {
  const rows = await db
    .select({ role: shares.role })
    .from(shares)
    .where(
      and(
        eq(shares.subjectType, subjectType),
        eq(shares.subjectId, subjectId),
        eq(shares.grantedToUserId, userId),
        isNull(shares.revokedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) return null;
  return parseAppShareRole(rows[0].role);
}

/**
 * Async visibility check that extends the pure `canViewSkill` predicate with
 * share grants. Routes use this instead of `canViewSkill` directly.
 */
export async function canActorAccessSkill(
  db: Database,
  skill: Pick<Skill, "id" | "ownerUserId" | "isStarter" | "archivedAt">,
  actor: Pick<SessionUser, "id" | "role">,
): Promise<boolean> {
  if (canViewSkill(skill, actor)) return true;
  if (skill.archivedAt) return false;
  return hasActiveShare(db, "skill", skill.id, actor.id);
}

/** Runnable = accessible and not archived; shares never bypass archival. */
export async function canActorRunSkill(
  db: Database,
  skill: Pick<Skill, "id" | "ownerUserId" | "isStarter" | "archivedAt">,
  actor: Pick<SessionUser, "id" | "role">,
): Promise<boolean> {
  if (skill.archivedAt) return false;
  return canActorAccessSkill(db, skill, actor);
}

/** Skills shared with a user (active grants, unarchived skills). */
export async function listSkillsSharedWith(
  db: Database,
  userId: string,
): Promise<Skill[]> {
  const rows = await db
    .select({ skill: skills })
    .from(shares)
    .innerJoin(skills, eq(shares.subjectId, skills.id))
    .where(
      and(
        eq(shares.subjectType, "skill"),
        eq(shares.grantedToUserId, userId),
        isNull(shares.revokedAt),
        isNull(skills.archivedAt),
      ),
    )
    .orderBy(desc(shares.createdAt));
  return rows.map((row) => row.skill);
}

/** Active grants on a subject, with recipient identity for the owner's UI. */
export async function listSharesForSubject(
  db: Database,
  subjectType: ShareSubjectType,
  subjectId: string,
): Promise<
  Array<{
    id: string;
    grantedToUserId: string;
    grantedToEmail: string;
    grantedToName: string;
    role: AppShareRole;
    createdAt: Date;
  }>
> {
  const rows = await db
    .select({
      id: shares.id,
      grantedToUserId: shares.grantedToUserId,
      grantedToEmail: users.email,
      grantedToName: users.displayName,
      role: shares.role,
      createdAt: shares.createdAt,
    })
    .from(shares)
    .innerJoin(users, eq(shares.grantedToUserId, users.id))
    .where(
      and(
        eq(shares.subjectType, subjectType),
        eq(shares.subjectId, subjectId),
        isNull(shares.revokedAt),
      ),
    )
    .orderBy(desc(shares.createdAt));
  return rows.map((row) => ({
    ...row,
    role: parseAppShareRole(row.role),
  }));
}

export async function createShare({
  db,
  actor,
  subjectType,
  subjectId,
  subjectSlug,
  recipientEmail,
  role = "viewer",
}: {
  db: Database;
  actor: SessionUser;
  subjectType: ShareSubjectType;
  subjectId: string;
  subjectSlug: string;
  recipientEmail: string;
  role?: AppShareRole;
}): Promise<
  | { ok: true; share: Share }
  | { ok: false; status: number; error: string; message: string }
> {
  const recipientRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, recipientEmail.trim().toLowerCase()))
    .limit(1);
  const recipient = recipientRows[0];
  if (!recipient) {
    return {
      ok: false,
      status: 404,
      error: "recipient_not_found",
      message:
        "No workspace user has that email. They need to sign in once (or be invited) first.",
    };
  }
  if (recipient.id === actor.id) {
    return {
      ok: false,
      status: 400,
      error: "cannot_share_with_self",
      message: "You already own this.",
    };
  }

  const inserted = await db
    .insert(shares)
    .values({
      subjectType,
      subjectId,
      grantedToUserId: recipient.id,
      grantedByUserId: actor.id,
      role: subjectType === "app" ? parseAppShareRole(role) : "viewer",
    })
    .onConflictDoNothing()
    .returning();
  const share = inserted[0];
  if (!share) {
    return {
      ok: false,
      status: 409,
      error: "already_shared",
      message: "Already shared with that user.",
    };
  }

  const now = new Date();
  await db.insert(auditLog).values({
    actorUserId: actor.id,
    actionType: subjectType === "app" ? "app_share_create" : "share_create",
    status: "succeeded",
    provider: "ai-hub",
    toolName: subjectSlug,
    input: { subjectType, subjectId },
    metadata: {
      grantedToUserId: recipient.id,
      shareId: share.id,
      role: share.role,
    },
    startedAt: now,
    completedAt: now,
  });

  return { ok: true, share };
}

export async function updateShareRole({
  db,
  actor,
  shareId,
  role,
}: {
  db: Database;
  actor: SessionUser;
  shareId: string;
  role: AppShareRole;
}): Promise<
  | { ok: true; share: Share }
  | { ok: false; status: number; error: string; message: string }
> {
  const rows = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, shareId), isNull(shares.revokedAt)))
    .limit(1);
  const share = rows[0];
  if (!share) {
    return {
      ok: false,
      status: 404,
      error: "share_not_found",
      message: "The share was not found.",
    };
  }
  if (share.subjectType !== "app") {
    return {
      ok: false,
      status: 400,
      error: "role_not_supported",
      message: "Only app shares support roles.",
    };
  }
  if (!(await canActorManageShare(db, share, actor))) {
    return {
      ok: false,
      status: 403,
      error: "not_grantor",
      message:
        "Only the person who shared this, the subject owner, or an admin can update it.",
    };
  }

  const now = new Date();
  const updated = await db
    .update(shares)
    .set({ role: parseAppShareRole(role), updatedAt: now })
    .where(eq(shares.id, share.id))
    .returning();

  await db.insert(auditLog).values({
    actorUserId: actor.id,
    actionType: "app_share_role_update",
    status: "succeeded",
    provider: "ai-hub",
    toolName: share.subjectType,
    input: {
      shareId: share.id,
      subjectType: share.subjectType,
      subjectId: share.subjectId,
    },
    metadata: {
      grantedToUserId: share.grantedToUserId,
      previousRole: share.role,
      role,
    },
    startedAt: now,
    completedAt: now,
  });

  return { ok: true, share: updated[0]! };
}

export async function revokeShare({
  db,
  actor,
  shareId,
}: {
  db: Database;
  actor: SessionUser;
  shareId: string;
}): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string; message: string }
> {
  const rows = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, shareId), isNull(shares.revokedAt)))
    .limit(1);
  const share = rows[0];
  if (!share) {
    return {
      ok: false,
      status: 404,
      error: "share_not_found",
      message: "The share was not found.",
    };
  }
  if (!(await canActorManageShare(db, share, actor))) {
    return {
      ok: false,
      status: 403,
      error: "not_grantor",
      message:
        "Only the person who shared this, the subject owner, or an admin can revoke it.",
    };
  }

  const now = new Date();
  await db
    .update(shares)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(shares.id, share.id));

  await db.insert(auditLog).values({
    actorUserId: actor.id,
    actionType:
      share.subjectType === "app" ? "app_share_revoke" : "share_revoke",
    status: "succeeded",
    provider: "ai-hub",
    toolName: share.subjectType,
    input: { shareId: share.id, subjectType: share.subjectType, subjectId: share.subjectId },
    metadata: { grantedToUserId: share.grantedToUserId },
    startedAt: now,
    completedAt: now,
  });

  return { ok: true };
}
