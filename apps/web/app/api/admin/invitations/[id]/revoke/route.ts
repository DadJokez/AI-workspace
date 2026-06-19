import { getDb, invitations } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminInvitationSelect,
  auditInvitationEvent,
  invitationStatus,
  toAdminInvitationRow,
} from "@/lib/admin-invitations";
import { requireAdmin } from "@/lib/auth/requireAdmin";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const db = getDb();
  const rows = await db
    .select(adminInvitationSelect)
    .from(invitations)
    .where(eq(invitations.id, id))
    .limit(1);
  const invitation = rows[0];
  if (!invitation) {
    return NextResponse.json({ error: "invitation_not_found" }, { status: 404 });
  }

  const status = invitationStatus(invitation);
  if (status === "accepted") {
    await auditInvitationEvent({
      db,
      actorUserId: auth.user.id,
      invitation,
      actionType: "invite.revoke",
      status: "denied",
      error: "invitation_already_accepted",
    });
    return NextResponse.json(
      { error: "invitation_already_accepted" },
      { status: 409 },
    );
  }

  const revokedAt = invitation.revokedAt ?? new Date();
  if (!invitation.revokedAt) {
    await db
      .update(invitations)
      .set({
        revokedAt,
        revokedBy: auth.user.id,
        updatedAt: revokedAt,
      })
      .where(eq(invitations.id, invitation.id));
    await auditInvitationEvent({
      db,
      actorUserId: auth.user.id,
      invitation,
      actionType: "invite.revoke",
      status: "succeeded",
    });
  }

  return NextResponse.json({
    invitation: toAdminInvitationRow(
      {
        ...invitation,
        revokedAt,
      },
      revokedAt,
    ),
  });
}
