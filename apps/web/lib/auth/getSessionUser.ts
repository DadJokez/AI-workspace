import type { SessionUser } from "@ai-workspace/auth";
import { getDb, users } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/nextauth";

/**
 * Resolve the current request to a fully populated session user — DB row
 * (`id`, `email`, `displayName`, `role`) read against the user id stamped
 * onto the NextAuth JWT during sign-in.
 *
 * We re-read from the `users` table on every call so an admin's role/email
 * change takes effect on the next request without forcing the user to
 * re-authenticate. `lastSeenAt` is bumped here too — same place we used to
 * bump it from `ensureUser`.
 *
 * Returns null when there is no session or the session's user id no longer
 * resolves to a row (e.g. the user was deleted while signed in).
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;

  const db = getDb();
  const refreshed = await db
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(eq(users.id, session.user.id))
    .returning();
  const row = refreshed[0];
  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
  };
}
