import {
  AuthConfigError,
  UnauthorizedError,
  type SessionUser,
} from "@ai-workspace/auth";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";

export type SessionRequirement =
  | { user: SessionUser }
  | { error: NextResponse };

/**
 * Resolve the current request to an authenticated session user.
 *
 * Route handlers return the error response verbatim so every API surface uses
 * the same structured 401 and auth-configuration 500 contracts.
 */
export async function requireSession(): Promise<SessionRequirement> {
  try {
    const user = await getSessionUser();
    if (!user) {
      return {
        error: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
    return { user };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        error: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
    if (error instanceof AuthConfigError) {
      return {
        error: NextResponse.json(
          { error: "auth_config_error", message: error.message },
          { status: 500 },
        ),
      };
    }
    throw error;
  }
}
