/**
 * Client-safe invitation types and predicates. This module must stay free
 * of server-only imports (db, auth, email) — it is imported by the
 * "use client" InvitationsPanel, and any server dependency here drags
 * node builtins into the browser bundle and breaks `next build` even
 * though typecheck passes (CLAUDE.md rubric #6). Server-side invitation
 * logic lives in admin-invitations.ts, which re-exports these so server
 * consumers keep a single import surface.
 */

export type InvitationRole = "admin" | "user";
export type InvitationEmailStatus = "not_sent" | "sent" | "failed";

export type AdminInvitationStatus =
  | "pending"
  | "sent"
  | "failed"
  | "expired"
  | "revoked"
  | "accepted";

export interface AdminInvitationRow {
  id: string;
  email: string;
  role: InvitationRole;
  status: AdminInvitationStatus;
  emailStatus: InvitationEmailStatus;
  emailAttempts: number;
  inviteUrl: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  lastEmailAttemptedAt: string | null;
  lastEmailSentAt: string | null;
  lastEmailError: string | null;
  googleTestUserRegisteredAt: string | null;
  canResend: boolean;
  canRevoke: boolean;
}

/**
 * True when the admin still needs to hand-add this invitee's email to the
 * Google OAuth app's test-user list (the app runs in External + Testing
 * mode and Google exposes no API for that list). Revoked and expired
 * invites drop off the list — those people aren't joining on this invite.
 */
export function needsGoogleTestUserRegistration(
  row: Pick<AdminInvitationRow, "status" | "googleTestUserRegisteredAt">,
): boolean {
  return (
    row.googleTestUserRegisteredAt === null &&
    row.status !== "revoked" &&
    row.status !== "expired"
  );
}
