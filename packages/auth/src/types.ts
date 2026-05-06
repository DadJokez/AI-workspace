/**
 * The authenticated user, as the rest of the app sees them.
 *
 * Week 1: populated from env vars (HARDCODED_USER_*).
 * Week 2: populated from a PingOne OIDC session. Same shape, same call sites.
 *
 * Field meanings stay stable across the swap:
 *   - `id` is the canonical user id (week 2: `users.ping_subject` upserted to `users.id`)
 *   - `email` is the primary work email
 *   - `displayName` is what the UI shows
 */
export interface User {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Coarse permission tier. Admins bypass per-user data scoping; everyone else
 * sees only their own rows. The first user ever to sign in is promoted to
 * `admin` in `ensureUser`.
 *
 * Mirrors `users.role` in the DB; kept in this package so callers that don't
 * (or can't) depend on `@ai-workspace/db` still get a type-safe handle on it.
 */
export type UserRole = "admin" | "user";

/**
 * What lives on the server-side session: the IdP claims (`User`) plus the
 * application-side role looked up against the `users` table.
 *
 * In a NextAuth world this is the shape of `session.user`; here it's the
 * return value of `getSessionUser` (apps/web/lib/auth/getSessionUser.ts).
 */
export interface SessionUser extends User {
  role: UserRole;
}
