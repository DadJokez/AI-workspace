import type { SessionUser } from "@ai-workspace/auth";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";

/**
 * Resolve the request to a session user and require `role = 'admin'`.
 *
 * Returns either `{ user }` on success or `{ error }` carrying the response
 * the caller should return verbatim (401 unauthenticated, 403 non-admin,
 * 500 auth misconfig). Mirrors the `authOrError` pattern in /api/user so
 * route handlers stay terse: `if ("error" in r) return r.error;`.
 */
export async function requireAdmin(): Promise<
  { user: SessionUser } | { error: NextResponse }
> {
  const session = await requireSession();
  if ("error" in session) return session;
  if (session.user.role !== "admin") {
    return {
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    };
  }
  return session;
}
