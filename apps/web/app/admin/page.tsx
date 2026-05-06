import { getDb, invitations, users } from "@ai-workspace/db";
import { and, desc, gt, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import type { AdminUserRow } from "@/app/api/admin/users/route";
import type { AdminInvitationRow } from "@/app/api/admin/invitations/route";
import { UsersTable } from "./UsersTable";
import { InvitationsPanel } from "./InvitationsPanel";

function inviteUrl(token: string): string {
  const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}/invite/${token}`;
}

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));

  const initialUsers: AdminUserRow[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    role: r.role,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }));

  const inviteRows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      token: invitations.token,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(
      and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())),
    )
    .orderBy(desc(invitations.createdAt));

  const initialInvitations: AdminInvitationRow[] = inviteRows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    inviteUrl: inviteUrl(r.token),
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));

  return (
    <>
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
      </section>
      <InvitationsPanel initialInvitations={initialInvitations} />
    </>
  );
}
