import { AuthConfigError, UnauthorizedError } from "./errors";
import type { User } from "./types";

/**
 * Returns the authenticated user, or null if the request is unauthenticated.
 *
 * Week 1 (this implementation): always returns the user described by the
 * HARDCODED_USER_ID / HARDCODED_USER_EMAIL / HARDCODED_USER_NAME env vars.
 * Throws `AuthConfigError` if the env vars are missing — that's a deploy bug,
 * not an auth failure.
 *
 * Week 2: implementation swaps to read a PingOne OIDC session. Same signature,
 * same return shape, same call sites. May then return null for unauthenticated
 * requests; week 1's implementation never returns null.
 */
export async function getCurrentUser(_req?: Request): Promise<User | null> {
  const id = process.env.HARDCODED_USER_ID;
  const email = process.env.HARDCODED_USER_EMAIL;
  const displayName = process.env.HARDCODED_USER_NAME;

  if (!id || !email || !displayName) {
    throw new AuthConfigError(
      "getCurrentUser (week 1): HARDCODED_USER_ID, HARDCODED_USER_EMAIL, " +
        "and HARDCODED_USER_NAME must all be set. See apps/web/.env.example. " +
        "This shim is replaced by PingOne OIDC in week 2.",
    );
  }

  return { id, email, displayName };
}

/**
 * Convenience wrapper that throws `UnauthorizedError` if the request is
 * unauthenticated. Use in API routes; catch at the route boundary and 401.
 */
export async function requireUser(req?: Request): Promise<User> {
  const user = await getCurrentUser(req);
  if (!user) throw new UnauthorizedError();
  return user;
}
