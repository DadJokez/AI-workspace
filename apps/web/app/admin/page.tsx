import { getDb, invitations, users } from "@ai-workspace/db";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import type { AdminUserRow } from "@/app/api/admin/users/route";
import { type AdminInvitationRow, buildInviteUrl } from "@/lib/invitations";
import { UsersTable } from "./UsersTable";
import { InvitePanel } from "./InvitePanel";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const db = getDb();
  const [userRows, inviteRows] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt)),
    db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        token: invitations.token,
        invitedBy: invitations.invitedBy,
        invitedByEmail: users.email,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(
        and(
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(invitations.createdAt)),
  ]);

  const initialUsers: AdminUserRow[] = userRows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    role: r.role,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }));

  const initialInvitations: AdminInvitationRow[] = inviteRows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: r.invitedBy,
    invitedByEmail: r.invitedByEmail,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    inviteUrl: buildInviteUrl(r.token),
  }));

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <h2 className="text-base font-semibold text-ink">Users</h2>
        <p className="mt-1 text-[12px] text-muted">
          {initialUsers.length} {initialUsers.length === 1 ? "user" : "users"}.
          Promote or demote with the role selector. You can&apos;t demote yourself.
        </p>
      </div>
      <UsersTable
        initialUsers={initialUsers}
        currentUserId={sessionUser.id}
      />
      <InvitePanel initialInvitations={initialInvitations} />
    </section>
  );
}
