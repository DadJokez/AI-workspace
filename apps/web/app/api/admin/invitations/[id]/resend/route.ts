import { getDb, invitations } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminInvitationSelect,
  invitationStatus,
  inviteEmailRateLimit,
  sendAndRecordInvitationEmail,
} from "@/lib/admin-invitations";
import { requireAdmin } from "@/lib/auth/requireAdmin";
import { checkRateLimit } from "@/lib/request-limits";

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
  if (status !== "pending" && status !== "sent" && status !== "failed") {
    return NextResponse.json(
      { error: "invitation_not_resendable", status },
      { status: 409 },
    );
  }

  const rate = await checkRateLimit(
    db,
    `invite-email:${auth.user.id}`,
    inviteEmailRateLimit,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many invitation emails. Please wait and try again.",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
          "X-RateLimit-Reset": rate.resetAt.toISOString(),
        },
      },
    );
  }

  const result = await sendAndRecordInvitationEmail({
    db,
    actor: auth.user,
    invitation,
    actionType: "invite.resend",
  });
  return NextResponse.json(result);
}
