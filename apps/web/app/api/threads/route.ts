import { AuthConfigError } from "@ai-workspace/auth";
import { chatThreads, getDb } from "@ai-workspace/db";
import { and, desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

/**
 * GET /api/threads?limit=8 — list threads, most recently updated first.
 *
 * `role = 'user'`  → caller's threads only.
 * `role = 'admin'` → all threads across the workspace (for the admin UI).
 */
export async function GET(req: Request) {
  let sessionUser;
  try {
    sessionUser = await getSessionUser(req);
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const parsed = limitParam ? Number(limitParam) : DEFAULT_LIMIT;
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const db = getDb();

  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      defaultModelId: chatThreads.defaultModelId,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
      userId: chatThreads.userId,
    })
    .from(chatThreads)
    .where(and(userScope(sessionUser, chatThreads.userId)))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(limit);

  return NextResponse.json({ threads: rows });
}
