import {
  auditLog,
  invitations,
  type Database,
} from "@ai-workspace/db";
import type { SessionUser } from "@ai-workspace/auth";
import { eq, sql } from "drizzle-orm";
import {
  InvitationEmailError,
  sendInvitationEmail,
} from "@/lib/invite-email";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const inviteEmailRateLimit = {
  maxRequestBytes: 8 * 1024,
  maxMessageChars: 512,
  windowMs: 60 * 60 * 1000,
  maxRequests: 20,
};

export {
  needsGoogleTestUserRegistration,
  type AdminInvitationRow,
  type AdminInvitationStatus,
  type InvitationEmailStatus,
  type InvitationRole,
} from "./admin-invitations-shared";
import type {
  AdminInvitationRow,
  AdminInvitationStatus,
  InvitationEmailStatus,
  InvitationRole,
} from "./admin-invitations-shared";

export interface AdminInvitationRecord {
  id: string;
  email: string;
  role: InvitationRole;
  token: string;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  emailStatus: InvitationEmailStatus;
  emailSendAttempts: number;
  lastEmailAttemptedAt: Date | null;
  lastEmailSentAt: Date | null;
  lastEmailError: string | null;
  lastEmailMessageId: string | null;
  googleTestUserRegisteredAt: Date | null;
  createdAt: Date;
}

export const adminInvitationSelect = {
  id: invitations.id,
  email: invitations.email,
  role: invitations.role,
  token: invitations.token,
  acceptedAt: invitations.acceptedAt,
  revokedAt: invitations.revokedAt,
  expiresAt: invitations.expiresAt,
  emailStatus: invitations.emailStatus,
  emailSendAttempts: invitations.emailSendAttempts,
  lastEmailAttemptedAt: invitations.lastEmailAttemptedAt,
  lastEmailSentAt: invitations.lastEmailSentAt,
  lastEmailError: invitations.lastEmailError,
  lastEmailMessageId: invitations.lastEmailMessageId,
  googleTestUserRegisteredAt: invitations.googleTestUserRegisteredAt,
  createdAt: invitations.createdAt,
};

export function inviteUrl(token: string): string {
  const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}/invite/${token}`;
}

export function toAdminInvitationRow(
  record: AdminInvitationRecord,
  now = new Date(),
): AdminInvitationRow {
  const status = invitationStatus(record, now);
  const actionable = status === "pending" || status === "sent" || status === "failed";
  return {
    id: record.id,
    email: record.email,
    role: record.role,
    status,
    emailStatus: record.emailStatus,
    emailAttempts: record.emailSendAttempts,
    inviteUrl: inviteUrl(record.token),
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    acceptedAt: isoOrNull(record.acceptedAt),
    revokedAt: isoOrNull(record.revokedAt),
    lastEmailAttemptedAt: isoOrNull(record.lastEmailAttemptedAt),
    lastEmailSentAt: isoOrNull(record.lastEmailSentAt),
    lastEmailError: record.lastEmailError,
    googleTestUserRegisteredAt: isoOrNull(record.googleTestUserRegisteredAt),
    canResend: actionable,
    canRevoke: actionable,
  };
}

export function invitationStatus(
  record: Pick<
    AdminInvitationRecord,
    "acceptedAt" | "revokedAt" | "expiresAt" | "emailStatus"
  >,
  now = new Date(),
): AdminInvitationStatus {
  if (record.acceptedAt) return "accepted";
  if (record.revokedAt) return "revoked";
  if (record.expiresAt.getTime() <= now.getTime()) return "expired";
  if (record.emailStatus === "sent") return "sent";
  if (record.emailStatus === "failed") return "failed";
  return "pending";
}

export async function auditInvitationEvent({
  db,
  actorUserId,
  invitation,
  actionType,
  status,
  error,
  metadata,
  startedAt = new Date(),
  completedAt = new Date(),
}: {
  db: Database;
  actorUserId: string;
  invitation: Pick<AdminInvitationRecord, "id" | "email" | "role">;
  actionType:
    | "invite.create"
    | "invite.send"
    | "invite.resend"
    | "invite.revoke"
    | "invite.accept"
    | "invite.google_test_user_registered";
  status: "succeeded" | "failed" | "denied";
  error?: string;
  metadata?: Record<string, unknown>;
  startedAt?: Date;
  completedAt?: Date;
}) {
  await db.insert(auditLog).values({
    actorUserId,
    actionType,
    status,
    provider: "ai-hub",
    toolName: "invitations",
    input: {
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role,
    },
    error,
    metadata,
    startedAt,
    completedAt,
  });
}

export async function sendAndRecordInvitationEmail({
  db,
  actor,
  invitation,
  actionType,
}: {
  db: Database;
  actor: SessionUser;
  invitation: AdminInvitationRecord;
  actionType: "invite.send" | "invite.resend";
}): Promise<{ invitation: AdminInvitationRow; warning?: string }> {
  const attemptedAt = new Date();
  try {
    const result = await sendInvitationEmail({
      to: invitation.email,
      role: invitation.role,
      inviteUrl: inviteUrl(invitation.token),
      expiresAt: invitation.expiresAt,
      invitedByName: actor.displayName || actor.email,
      invitedByEmail: actor.email,
    });
    const sentAt = new Date();
    await db
      .update(invitations)
      .set({
        emailStatus: "sent",
        emailSendAttempts: sql`${invitations.emailSendAttempts} + 1`,
        lastEmailAttemptedAt: attemptedAt,
        lastEmailSentAt: sentAt,
        lastEmailError: null,
        lastEmailMessageId: result.messageId,
        updatedAt: sentAt,
      })
      .where(eq(invitations.id, invitation.id));
    await auditInvitationEvent({
      db,
      actorUserId: actor.id,
      invitation,
      actionType,
      status: "succeeded",
      metadata: {
        provider: result.provider,
        messageId: result.messageId,
        attempt: invitation.emailSendAttempts + 1,
      },
      startedAt: attemptedAt,
      completedAt: sentAt,
    });
    return {
      invitation: toAdminInvitationRow(
        {
          ...invitation,
          emailStatus: "sent",
          emailSendAttempts: invitation.emailSendAttempts + 1,
          lastEmailAttemptedAt: attemptedAt,
          lastEmailSentAt: sentAt,
          lastEmailError: null,
          lastEmailMessageId: result.messageId,
        },
        sentAt,
      ),
    };
  } catch (err) {
    const completedAt = new Date();
    const error = invitationEmailErrorCode(err);
    await db
      .update(invitations)
      .set({
        emailStatus: "failed",
        emailSendAttempts: sql`${invitations.emailSendAttempts} + 1`,
        lastEmailAttemptedAt: attemptedAt,
        lastEmailError: error,
        updatedAt: completedAt,
      })
      .where(eq(invitations.id, invitation.id));
    await auditInvitationEvent({
      db,
      actorUserId: actor.id,
      invitation,
      actionType,
      status: "failed",
      error,
      metadata: { attempt: invitation.emailSendAttempts + 1 },
      startedAt: attemptedAt,
      completedAt,
    });
    console.error("Invitation email send failed", {
      invitationId: invitation.id,
      error,
    });
    return {
      invitation: toAdminInvitationRow(
        {
          ...invitation,
          emailStatus: "failed",
          emailSendAttempts: invitation.emailSendAttempts + 1,
          lastEmailAttemptedAt: attemptedAt,
          lastEmailError: error,
        },
        completedAt,
      ),
      warning: error,
    };
  }
}

export function invitationEmailErrorCode(err: unknown): string {
  if (err instanceof InvitationEmailError) return err.code;
  return "email_send_failed";
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}
