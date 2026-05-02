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
