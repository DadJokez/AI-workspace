import type { SessionUser } from "@ai-workspace/auth";
import { getDb, users, type Database, type User } from "@ai-workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/nextauth";

/** `last_seen_at` is written at most once per this many minutes per user. */
export const LAST_SEEN_WRITE_INTERVAL_MINUTES = 5;

const LAST_SEEN_WINDOW = sql.raw(
  `interval '${LAST_SEEN_WRITE_INTERVAL_MINUTES} minutes'`,
);

/**
 * Resolve the current request to a fully populated session user — DB row
 * (`id`, `email`, `displayName`, `role`) read against the user id stamped
 * onto the NextAuth JWT during sign-in.
 *
 * The row is re-read on every call, so a role or email change takes effect
 * on the next request, and the JWT alone never authorizes anything: the
 * session counts only while the user is `active` and the token's `sv` equals
 * `users.session_version`. Suspending or deprovisioning a user bumps that
 * version (`lib/user-lifecycle.ts`), so a token that is still cryptographically
 * valid and unexpired is refused from the next request on. Every API route
 * and server-rendered page resolves its user here (`requireSession`,
 * `requireAdmin`); the edge middleware's JWT-only check is page gating, not
 * authorization (see `middleware.ts`).
 *
 * Returns null when there is no session, the user row is gone, the user is
 * not active, or the token predates the user's current session version.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;

  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const row = rows[0];
  if (!row || !sessionIsCurrent(row, session.user.sessionVersion)) return null;

  await touchLastSeen(db, row.id);

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
  };
}

/**
 * A session counts only for an active user whose token carries the row's
 * current session version. A token without a version (issued before WP-18)
 * never matches.
 */
export function sessionIsCurrent(
  row: Pick<User, "status" | "sessionVersion">,
  tokenSessionVersion: unknown,
): boolean {
  return row.status === "active" && tokenSessionVersion === row.sessionVersion;
}

/**
 * Bump `last_seen_at`, but only when the stored value is older than the
 * write interval: one conditional UPDATE that matches no row on all but the
 * first request of each window, instead of a row write on every request.
 * Both sides of the comparison use the database clock.
 */
export async function touchLastSeen(
  db: Database,
  userId: string,
): Promise<void> {
  await db
    .update(users)
    .set({ lastSeenAt: sql`now()` })
    .where(
      and(
        eq(users.id, userId),
        sql`${users.lastSeenAt} < now() - ${LAST_SEEN_WINDOW}`,
      ),
    );
}
