import {
  UnauthorizedError,
  type SessionUser,
  type User,
} from "@ai-workspace/auth";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/nextauth";

/**
 * Read the NextAuth session. Returns the full `SessionUser` (id, email,
 * displayName, role) — replaces the week-1 env-var shim.
 *
 * Note: callers that historically passed a `Request` to `getCurrentUser(req)`
 * may keep doing so; we don't need it because `getServerSession` reads cookies
 * via Next's request context.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    displayName: session.user.displayName ?? session.user.name ?? "",
    role: session.user.role,
  };
}

/**
 * Slimmer `User` (no `role`) for callers that don't care about admin gating.
 * Identical to `getSessionUser` for now — kept distinct so the signature
 * matches the previous `@ai-workspace/auth` export and so we can later
 * re-introduce a non-DB path if needed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getCurrentUser(_req?: Request): Promise<User | null> {
  const u = await getSessionUser();
  if (!u) return null;
  return { id: u.id, email: u.email, displayName: u.displayName };
}

export async function requireUser(req?: Request): Promise<User> {
  const u = await getCurrentUser(req);
  if (!u) throw new UnauthorizedError();
  return u;
}
