import {
  type User as DbUser,
  getDb,
  users,
} from "@ai-workspace/db";
import type { User as AuthUser } from "@ai-workspace/auth";
import { eq } from "drizzle-orm";

/**
 * Upsert the authenticated user into the `users` table on each request that
 * needs a DB row. `pingSubject` is the canonical identity (env-var hardcoded
 * id in week 1; OIDC `sub` in week 2+).
 *
 * On update we deliberately do NOT overwrite `display_name` from the auth
 * payload — the DB row is authoritative once a user has set a name via
 * Settings. Email is still refreshed (the IdP owns that). `lastSeenAt` is
 * always bumped.
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

  const inserted = await db
    .insert(users)
    .values({
      pingSubject: authUser.id,
      email: authUser.email,
      displayName: authUser.displayName,
    })
    .returning();
  return inserted[0]!;
}
