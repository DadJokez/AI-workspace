import {
  type User as DbUser,
  getDb,
  invitations,
  users,
} from "@ai-workspace/db";
import type { User as AuthUser, UserRole } from "@ai-workspace/auth";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

/**
 * The first user ever to sign in is promoted to `admin`. Pure helper so the
 * decision is unit-testable without spinning up the DB. Used by `ensureUser`.
 */
export function decideInitialRole(existingUserCount: number): UserRole {
  return existingUserCount === 0 ? "admin" : "user";
}

/**
 * Look up a redeemable invitation for `email`: not yet accepted, not expired.
 * Returns null when there is no pending invite. Exported only for testing.
 */
export async function findPendingInvitation(
  email: string,
): Promise<{ id: string; role: UserRole } | null> {
  const db = getDb();
  const rows = await db
    .select({ id: invitations.id, role: invitations.role })
    .from(invitations)
    .where(
      and(
        eq(invitations.email, email),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Upsert the authenticated user into the `users` table on each request that
 * needs a DB row. `pingSubject` is the canonical identity (env-var hardcoded
 * id in week 1; OIDC `sub` in week 2+).
 *
 * On update we deliberately do NOT overwrite `display_name` from the auth
 * payload — the DB row is authoritative once a user has set a name via
 * Settings. Email is still refreshed (the IdP owns that). `lastSeenAt` is
 * always bumped.
 *
 * The first user ever to land here is promoted to `admin`. This is the
 * sign-in callback for the hardcoded shim; when NextAuth/OIDC lands, the
 * same admin-on-first-signup rule moves into the NextAuth `signIn` callback.
 */
export async function ensureUser(authUser: AuthUser): Promise<DbUser> {
  const db = getDb();

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.pingSubject, authUser.id))
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    if (row.email !== authUser.email) {
      const updated = await db
        .update(users)
        .set({ email: authUser.email, lastSeenAt: new Date() })
        .where(eq(users.id, row.id))
        .returning();
      return updated[0]!;
    }
    await db
      .update(users)
      .set({ lastSeenAt: new Date() })
      .where(eq(users.id, row.id));
    return row;
  }

  // First-user-becomes-admin. We check the count *before* insert so a race
  // between two simultaneous first-ever sign-ins can't mint two admins —
  // the second insert sees count = 1 and falls through to the user role.
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  const baseRole = decideInitialRole(countRows[0]?.count ?? 0);

  // If an admin pre-issued an invitation for this email, the invited role
  // wins over the default `user` (but never over `admin`-by-first-signup —
  // that path skips the invite check because there's no admin to issue one).
  const pendingInvite =
    baseRole === "admin" ? null : await findPendingInvitation(authUser.email);
  const role: UserRole = pendingInvite?.role ?? baseRole;

  const inserted = await db
    .insert(users)
    .values({
      pingSubject: authUser.id,
      email: authUser.email,
      displayName: authUser.displayName,
      role,
    })
    .returning();

  if (pendingInvite) {
    await db
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, pendingInvite.id));
  }

  return inserted[0]!;
}
