import { getDb, invitations, users } from "@ai-workspace/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import type { AdminInvitationRow } from "@/app/api/admin/invitations/route";
import { InvitationsClient } from "./InvitationsClient";

export const dynamic = "force-dynamic";

export default async function AdminInvitationsPage() {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const db = getDb();
  const now = new Date();
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      invitedByEmail: users.email,
    })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(
      and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, now)),
    )
    .orderBy(desc(invitations.createdAt));

  const initial: AdminInvitationRow[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedByEmail: r.invitedByEmail,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));

  return <InvitationsClient initialInvitations={initial} />;
}
