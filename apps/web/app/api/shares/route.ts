import { apps, getDb, skills } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  createShare,
  parseAppShareRole,
  type ShareSubjectType,
} from "@/lib/shares";

export const dynamic = "force-dynamic";

/**
 * Share a skill or an app with a named workspace user by email. Only the
 * subject's owner can share it (FR-010). A share grants visibility +
 * run/open + clone — never edit, never the owner's credentials.
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
  const { subjectType, subjectId, email, role } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (subjectType !== "skill" && subjectType !== "app") {
    return NextResponse.json(
      { error: "unsupported_subject_type" },
      { status: 400 },
    );
  }
  if (typeof subjectId !== "string" || !subjectId) {
    return NextResponse.json({ error: "invalid_subject" }, { status: 400 });
  }
  if (typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const db = getDb();
  const subject = await loadSubject(db, subjectType, subjectId);
  if (!subject || subject.archivedAt) {
    return NextResponse.json(
      { error: `${subjectType}_not_found` },
      { status: 404 },
    );
  }
  if (subject.ownerUserId !== sessionUser.id) {
    return NextResponse.json(
      {
        error: "not_owner",
        message: `Only the ${subjectType}'s owner can share it.`,
      },
      { status: 403 },
    );
  }

  const result = await createShare({
    db,
    actor: sessionUser,
    subjectType,
    subjectId: subject.id,
    subjectSlug: subject.slug,
    recipientEmail: email,
    role: subjectType === "app" ? parseAppShareRole(role) : "viewer",
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status },
    );
  }
  return NextResponse.json({ share: result.share }, { status: 201 });
}

async function loadSubject(
  db: ReturnType<typeof getDb>,
  subjectType: ShareSubjectType,
  subjectId: string,
): Promise<{
  id: string;
  slug: string;
  ownerUserId: string;
  archivedAt: Date | null;
} | null> {
  if (subjectType === "skill") {
    const rows = await db
      .select({
        id: skills.id,
        slug: skills.slug,
        ownerUserId: skills.ownerUserId,
        archivedAt: skills.archivedAt,
      })
      .from(skills)
      .where(eq(skills.id, subjectId))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db
    .select({
      id: apps.id,
      slug: apps.slug,
      ownerUserId: apps.ownerUserId,
      archivedAt: apps.archivedAt,
    })
    .from(apps)
    .where(eq(apps.id, subjectId))
    .limit(1);
  return rows[0] ?? null;
}
