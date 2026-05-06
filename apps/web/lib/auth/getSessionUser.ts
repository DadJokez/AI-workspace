import { getCurrentUser, type SessionUser } from "@ai-workspace/auth";
import { ensureUser } from "@/lib/users";

/**
 * Resolve the current request to a fully populated session user — IdP claims
 * (`getCurrentUser`) plus the DB-side `role`. Returns null if the request is
 * unauthenticated; throws `AuthConfigError`/`UnauthorizedError` exactly the
 * same way `getCurrentUser` does, so callers can keep their existing catch
 * blocks.
 *
 * This is what callers should use when they need to gate behavior on role
 * (admin bypass on data scoping, /admin route access, etc.). Routes that
 * don't care about role can stay on `getCurrentUser` + `ensureUser`.
 */
export async function getSessionUser(req?: Request): Promise<SessionUser | null> {
  const authUser = await getCurrentUser(req);
  if (!authUser) return null;
  const dbUser = await ensureUser(authUser);
  return {
    id: dbUser.id,
    email: dbUser.email,
    displayName: dbUser.displayName,
    role: dbUser.role,
  };
}
