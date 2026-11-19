import { chatThreads, getDb } from "@ai-workspace/db";
import { asc, desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { userScope } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

/**
 * GET /api/threads?limit=8 — the caller's threads, pinned first, then by
 * recency. Scoped to the caller for every role: an admin's list is the
 * admin's own threads.
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
    .from(chatThreads)
    .where(userScope(sessionUser, chatThreads.userId))
    .orderBy(
      desc(chatThreads.pinned),
      desc(chatThreads.updatedAt),
      asc(chatThreads.id),
    )
    .limit(limit);

  return NextResponse.json({ threads: rows });
}
