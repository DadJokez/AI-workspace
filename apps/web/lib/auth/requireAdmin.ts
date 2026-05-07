import {
  AuthConfigError,
  UnauthorizedError,
  type SessionUser,
} from "@ai-workspace/auth";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";

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
  try {
    const user = await getSessionUser();
    if (!user) {
      return {
        error: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
    if (user.role !== "admin") {
      return {
        error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
      };
    }
    return { user };
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return {
        error: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
    if (err instanceof AuthConfigError) {
      return {
        error: NextResponse.json(
          { error: "auth_config_error", message: err.message },
          { status: 500 },
        ),
      };
    }
    throw err;
  }
}
