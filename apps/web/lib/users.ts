import {
  type User as DbUser,
  getDb,
  users,
} from "@ai-workspace/db";
import type { User as AuthUser, UserRole } from "@ai-workspace/auth";
import { eq, sql } from "drizzle-orm";
import {
  findPendingInvitationForEmail,
  markInvitationAccepted,
} from "@/lib/invitations";

/**
 * The first user ever to sign in is promoted to `admin`. Pure helper so the
 * decision is unit-testable without spinning up the DB. Used by `ensureUser`.
 */
export function decideInitialRole(existingUserCount: number): UserRole {
  return existingUserCount === 0 ? "admin" : "user";
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
  const defaultRole = decideInitialRole(countRows[0]?.count ?? 0);

  // An admin-issued invitation overrides the first-user-admin default. We
  // match by email (case-insensitive) and require a live row — pending and
  // unexpired. The invite is consumed only on first user creation; later
  // sign-ins by the same email are no-ops here. Realistically, the
  // first-ever signup has no invitations to redeem (the table is empty
  // until an admin exists), but we don't gate on that — the spec says the
  // invited role wins.
  const invitation = await findPendingInvitationForEmail(authUser.email);
  const role = invitation ? invitation.role : defaultRole;

  const inserted = await db
    .insert(users)
    .values({
      pingSubject: authUser.id,
      email: authUser.email,
      displayName: authUser.displayName,
      role,
    })
    .returning();

  if (invitation) {
    await markInvitationAccepted(invitation.id);
  }

  return inserted[0]!;
}
