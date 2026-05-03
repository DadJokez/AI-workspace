import { AuthConfigError, getCurrentUser } from "@ai-workspace/auth";
import { chatThreads, getDb } from "@ai-workspace/db";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ensureUser } from "@/lib/users";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

/**
 * GET /api/threads?limit=8 — list the caller's threads, most recently updated first.
 */
export async function GET(req: Request) {
  let authUser;
  try {
    authUser = await getCurrentUser(req);
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!authUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const parsed = limitParam ? Number(limitParam) : DEFAULT_LIMIT;
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const dbUser = await ensureUser(authUser);
  const db = getDb();

  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      defaultModelId: chatThreads.defaultModelId,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.userId, dbUser.id))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(limit);

  return NextResponse.json({ threads: rows });
}
