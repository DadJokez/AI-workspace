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

  // Role precedence on first sign-in:
  //   1. An admin-issued, still-pending invitation wins. We match on email
  //      case-insensitively (the API normalizes to lowercase, but auth
  //      payloads aren't guaranteed to). Stamping `accepted_at` consumes the
  //      invitation so a second sign-in with the same email doesn't keep
  //      reapplying the role.
  //   2. Otherwise the first user ever in the table is promoted to `admin`,
  //      everyone else defaults to `user`. We count *before* insert so a
  //      race between two simultaneous first-ever sign-ins can't mint two
  //      admins.
  const pendingInvite = await db
    .select({ id: invitations.id, role: invitations.role })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = lower(${authUser.email})`,
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, sql`now()`),
      ),
    )
    .limit(1);

  let role: UserRole;
  if (pendingInvite[0]) {
    role = pendingInvite[0].role;
  } else {
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    role = decideInitialRole(countRows[0]?.count ?? 0);
  }

  const inserted = await db
    .insert(users)
    .values({
      pingSubject: authUser.id,
      email: authUser.email,
      displayName: authUser.displayName,
      role,
    })
    .returning();

  if (pendingInvite[0]) {
    await db
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(eq(invitations.id, pendingInvite[0].id));
  }

  return inserted[0]!;
}
