import { chatThreads, getDb } from "@ai-workspace/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auditAdminDataAccessBatch } from "@/lib/admin-data-access";
import { requireSession } from "@/lib/auth/requireSession";
import { userScope } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

/**
 * GET /api/threads?limit=8 — list pinned threads first, then by recency.
 *
 * `role = 'user'`  → caller's threads only.
 * `role = 'admin'` → all threads across the workspace (for the admin UI),
 * unless `scope=mine` is requested by a personal navigation surface.
 */
export async function GET(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const parsed = limitParam ? Number(limitParam) : DEFAULT_LIMIT;
  const limit =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const personalScope = url.searchParams.get("scope") === "mine";
  const scope =
    personalScope
      ? eq(chatThreads.userId, sessionUser.id)
      : userScope(sessionUser, chatThreads.userId);

  const db = getDb();

  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      pinned: chatThreads.pinned,
      defaultModelId: chatThreads.defaultModelId,
      previewSummary: chatThreads.previewSummary,
      previewSummaryUpdatedAt: chatThreads.previewSummaryUpdatedAt,
      titleSource: chatThreads.titleSource,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
      userId: chatThreads.userId,
    })
    // scoping-guard-allow: predicate is the `scope` variable built from userScope() above and applied in the .where() below
    .from(chatThreads)
    .where(and(scope))
    .orderBy(
      desc(chatThreads.pinned),
      desc(chatThreads.updatedAt),
      asc(chatThreads.id),
    )
    .limit(limit);

  await auditAdminDataAccessBatch({
    db,
    actor: sessionUser,
    accesses: rows.map((thread) => ({
      targetUserId: thread.userId,
      resourceType: "chat_thread_collection",
      resourceId: personalScope ? "mine" : "workspace",
      surface: "thread_list",
      resourceCount: 1,
    })),
  });

  return NextResponse.json({ threads: rows });
}
