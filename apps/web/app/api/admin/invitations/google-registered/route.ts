import { getDb, invitations } from "@ai-workspace/db";
import { and, inArray, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminInvitationSelect,
  auditInvitationEvent,
  toAdminInvitationRow,
} from "@/lib/admin-invitations";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

interface PostBody {
  ids?: unknown;
}

/**
 * Record that the admin has hand-added the invitees' emails to the Google
 * OAuth app's test-user list (Google Auth Platform → Audience). Google has
 * no API for that list, so this timestamp is the product's only record of
 * who was registered. Accepts one id (per-row action) or many (mark-all).
 * Idempotent: already-registered rows keep their original timestamp.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string")
    : [];
  if (ids.length === 0 || ids.length > 100) {
    return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select(adminInvitationSelect)
    .from(invitations)
    .where(inArray(invitations.id, ids));
  if (rows.length === 0) {
    return NextResponse.json({ error: "invitation_not_found" }, { status: 404 });
  }

  const registeredAt = new Date();
  const unregistered = rows.filter((r) => !r.googleTestUserRegisteredAt);
  if (unregistered.length > 0) {
    await db
      .update(invitations)
      .set({
        googleTestUserRegisteredAt: registeredAt,
        updatedAt: registeredAt,
      })
      .where(
        and(
          inArray(
            invitations.id,
            unregistered.map((r) => r.id),
          ),
          isNull(invitations.googleTestUserRegisteredAt),
        ),
      );
    for (const invitation of unregistered) {
      await auditInvitationEvent({
        db,
        actorUserId: auth.user.id,
        invitation,
        actionType: "invite.google_test_user_registered",
        status: "succeeded",
      });
    }
  }

  return NextResponse.json({
    invitations: rows.map((r) =>
      toAdminInvitationRow(
        {
          ...r,
          googleTestUserRegisteredAt: r.googleTestUserRegisteredAt ?? registeredAt,
        },
        registeredAt,
      ),
    ),
  });
}
