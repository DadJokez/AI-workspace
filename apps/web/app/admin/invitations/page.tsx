import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { inviteUrlFor, listPendingInvitations } from "@/lib/invitations";
import type { PendingInvitationDto } from "@/app/api/admin/invitations/route";
import { InvitationsClient } from "./InvitationsClient";

export const dynamic = "force-dynamic";

export default async function AdminInvitationsPage() {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  // Build a fake-but-realistic request URL for the inviteUrlFor fallback so
  // dev environments without NEXTAUTH_URL still produce working links.
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost";
  const requestUrl = `${proto}://${host}`;

  const rows = await listPendingInvitations();
  const initial: PendingInvitationDto[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    token: r.token,
    invitedByName: r.invitedByName,
    invitedByEmail: r.invitedByEmail,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    inviteUrl: inviteUrlFor(r.token, requestUrl),
  }));

  return <InvitationsClient initialInvitations={initial} />;
}
