import { AuthConfigError } from "@ai-workspace/auth";
import { chatThreads, getDb } from "@ai-workspace/db";
import { and, desc, eq } from "drizzle-orm";
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
 * `role = 'admin'` → all threads across the workspace (for the admin UI),
 * unless `scope=mine` is requested by a personal navigation surface.
 */
export async function GET(req: Request) {
  let sessionUser;
  try {
    sessionUser = await getSessionUser();
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
  const scope =
    url.searchParams.get("scope") === "mine"
      ? eq(chatThreads.userId, sessionUser.id)
      : userScope(sessionUser, chatThreads.userId);

  const db = getDb();

  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      defaultModelId: chatThreads.defaultModelId,
      previewSummary: chatThreads.previewSummary,
      previewSummaryUpdatedAt: chatThreads.previewSummaryUpdatedAt,
      titleSource: chatThreads.titleSource,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
      userId: chatThreads.userId,
    })
    .from(chatThreads)
    .where(and(scope))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(limit);

  return NextResponse.json({ threads: rows });
}
