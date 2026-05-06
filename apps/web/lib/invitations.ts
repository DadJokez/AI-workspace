import { randomBytes } from "node:crypto";
import { type Invitation, getDb, invitations } from "@ai-workspace/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

/** 7 days. The spec; not configurable. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 32 bytes → 64 hex chars. 256 bits of entropy makes collisions vanishingly
 * unlikely; the DB also enforces uniqueness via `invitations_token_idx`, so
 * a collision would surface as a 23505 (`unique_violation`) on insert.
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("hex");
}

export function expiresAtFromNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_MS);
}

export type InvitationStatus = "valid" | "expired" | "accepted" | "not_found";

export interface InvitationLookup {
  status: InvitationStatus;
  invitation?: Invitation;
}

/**
 * Look up an invitation by its opaque URL token and classify it. Used by the
 * `/invite/[token]` landing page (read-only) and by the consume path inside
 * `ensureUser`. Splitting "exists / accepted / expired" three ways lets the
 * landing page show specific error states instead of a generic 404.
 */
export async function lookupInvitation(
  token: string,
  now: Date = new Date(),
): Promise<InvitationLookup> {
  const db = getDb();
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);
  const inv = rows[0];
  if (!inv) return { status: "not_found" };
  if (inv.acceptedAt) return { status: "accepted", invitation: inv };
  if (inv.expiresAt.getTime() <= now.getTime()) {
    return { status: "expired", invitation: inv };
  }
  return { status: "valid", invitation: inv };
}

/**
 * Find a usable invitation matching `email` (case-insensitive), if any. Used
 * by `ensureUser` on first user creation to pre-assign role and stamp
 * `accepted_at`. Returns `undefined` when no live invitation matches; callers
 * fall through to default role assignment.
 */
export async function findPendingInvitationForEmail(
  email: string,
  now: Date = new Date(),
): Promise<Invitation | undefined> {
  const db = getDb();
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = lower(${email})`,
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Mark an invitation accepted. Idempotent in the sense that callers should
 * already have verified `acceptedAt IS NULL` (typically via
 * `findPendingInvitationForEmail`); the conditional `WHERE` guards against
 * a concurrent second redemption stamping a stale `acceptedAt`.
 */
export async function markInvitationAccepted(
  id: string,
  acceptedAt: Date = new Date(),
): Promise<void> {
  const db = getDb();
  await db
    .update(invitations)
    .set({ acceptedAt })
    .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)));
}
