import { getDb, skills } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { createShare } from "@/lib/shares";

export const dynamic = "force-dynamic";

/**
 * Share a skill with a named workspace user by email. Only the subject's
 * owner can share it (FR-010). Apps reuse this endpoint with
 * subjectType: "app" once the apps registry ships.
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
  const { subjectType, subjectId, email } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (subjectType !== "skill") {
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
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.id, subjectId))
    .limit(1);
  const skill = rows[0];
  if (!skill || skill.archivedAt) {
    return NextResponse.json({ error: "skill_not_found" }, { status: 404 });
  }
  if (skill.ownerUserId !== sessionUser.id) {
    return NextResponse.json(
      {
        error: "not_owner",
        message: "Only the skill's owner can share it.",
      },
      { status: 403 },
    );
  }

  const result = await createShare({
    db,
    actor: sessionUser,
    subjectType: "skill",
    subjectId: skill.id,
    subjectSlug: skill.slug,
    recipientEmail: email,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, message: result.message },
      { status: result.status },
    );
  }
  return NextResponse.json({ share: result.share }, { status: 201 });
}
