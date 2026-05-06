import { randomBytes } from "node:crypto";
import {
  type Invitation,
  getDb,
  invitations,
  users,
} from "@ai-workspace/db";
import type { UserRole } from "@ai-workspace/auth";
import { and, desc, eq, gt, isNull } from "drizzle-orm";

/** 7 days in milliseconds. Invitations created today expire next week. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Treat email matching as case-insensitive throughout the invite flow:
 * the IdP can return any casing, and we don't want "Bob@Example.com" to
 * miss an invite issued to "bob@example.com".
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("hex");
}

export interface CreateInvitationInput {
  email: string;
  role: UserRole;
  invitedBy: string;
  now?: Date;
}

export async function createInvitation(
  input: CreateInvitationInput,
): Promise<Invitation> {
  const db = getDb();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const inserted = await db
    .insert(invitations)
    .values({
      email: normalizeEmail(input.email),
      role: input.role,
      token: generateInviteToken(),
      invitedBy: input.invitedBy,
      expiresAt,
    })
    .returning();
  return inserted[0]!;
}

export interface InvitationLookupResult {
  status: "valid" | "expired" | "accepted" | "not_found";
  invitation?: Invitation;
}

/**
 * Look up an invitation by its URL token and classify it. The page handler
 * shows different copy for each non-valid status, so we expose them rather
 * than collapsing to a boolean.
 */
export async function lookupInvitationByToken(
  token: string,
  now: Date = new Date(),
): Promise<InvitationLookupResult> {
  const db = getDb();
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);
  const row = rows[0];
  if (!row) return { status: "not_found" };
  if (row.acceptedAt) return { status: "accepted", invitation: row };
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { status: "expired", invitation: row };
  }
  return { status: "valid", invitation: row };
}

/**
 * Atomically claim the newest pending invitation for an email and return its
 * pre-assigned role. Used by `ensureUser` on first sign-in. Returns null if
 * there's nothing pending — the caller falls back to the default role logic
 * (first-user-becomes-admin / `user`).
 *
 * Atomicity matters: two simultaneous first-sign-ins for the same email
 * (rare but possible) must not both consume the same invite. We use an
 * UPDATE ... WHERE accepted_at IS NULL AND expires_at > now() so the
 * second writer's update simply matches zero rows.
 */
export async function consumePendingInvitationForEmail(
  email: string,
  now: Date = new Date(),
): Promise<UserRole | null> {
  const db = getDb();
  const normalized = normalizeEmail(email);

  const candidates = await db
    .select({ id: invitations.id, role: invitations.role })
    .from(invitations)
    .where(
      and(
        eq(invitations.email, normalized),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .orderBy(desc(invitations.createdAt))
    .limit(1);

  const candidate = candidates[0];
  if (!candidate) return null;

  const claimed = await db
    .update(invitations)
    .set({ acceptedAt: now })
    .where(
      and(
        eq(invitations.id, candidate.id),
        isNull(invitations.acceptedAt),
      ),
    )
    .returning({ role: invitations.role });

  return claimed[0]?.role ?? null;
}

export interface PendingInvitationRow {
  id: string;
  email: string;
  role: UserRole;
  token: string;
  invitedByName: string;
  invitedByEmail: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * List invitations that are still pending (not accepted, not expired). Joins
 * the inviter's display name/email so the admin UI can attribute each row
 * without a second round trip.
 */
export async function listPendingInvitations(
  now: Date = new Date(),
): Promise<PendingInvitationRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      token: invitations.token,
      invitedByName: users.displayName,
      invitedByEmail: users.email,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .innerJoin(users, eq(invitations.invitedBy, users.id))
    .where(
      and(
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .orderBy(desc(invitations.createdAt));

  return rows;
}

/**
 * Build the absolute URL the admin shares. Prefers `NEXTAUTH_URL` (the env
 * var the spec calls out for the imminent NextAuth wire-up); falls back to
 * `APP_BASE_URL` (already used elsewhere) and finally the request's own
 * origin so dev works without any env config.
 */
export function inviteUrlFor(token: string, requestUrl?: string): string {
  const base =
    process.env.NEXTAUTH_URL ??
    process.env.APP_BASE_URL ??
    (requestUrl ? new URL(requestUrl).origin : "");
  return `${base.replace(/\/$/, "")}/invite/${token}`;
}

