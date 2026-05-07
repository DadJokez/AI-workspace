import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { getDb, oauthTokens } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/session";
import { ensureUser } from "@/lib/users";

export const dynamic = "force-dynamic";

type Provider = "github" | "notion" | "google";

/**
 * GET /api/oauth/status — { github, notion, google } booleans for the caller.
 */
export async function GET(req: Request) {
  let authUser;
  try {
    authUser = await requireUser(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }

  const dbUser = await ensureUser(authUser);
  const db = getDb();

  const rows = await db
    .select({ provider: oauthTokens.provider })
    .from(oauthTokens)
    .where(eq(oauthTokens.userId, dbUser.id));

  const connected = new Set(rows.map((r) => r.provider));
  const status: Record<Provider, boolean> = {
    github: connected.has("github"),
    notion: connected.has("notion"),
    google: connected.has("google"),
  };

  return NextResponse.json(status);
}
