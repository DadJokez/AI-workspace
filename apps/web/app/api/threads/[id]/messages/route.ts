import { chatThreads, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { userScope } from "@/lib/auth/scope";
import { loadThreadMessagesWithRunActivity } from "@/lib/thread-messages";
import {
  loadThreadAlternativeLinks,
  loadThreadBranchLineage,
} from "@/lib/thread-branches";

export const dynamic = "force-dynamic";

/**
 * GET /api/threads/[id]/messages — list messages on a thread the caller
 * owns. Owner only for every role: another user's thread is a 404.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const { id: threadId } = await params;
  if (!threadId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();

  const owned = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, threadId),
        userScope(sessionUser, chatThreads.userId),
      ),
    )
    .limit(1);
  if (!owned[0]) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  const [rows, lineage, alternatives] = await Promise.all([
    loadThreadMessagesWithRunActivity({
      db,
      threadId,
      actor: sessionUser,
    }),
    loadThreadBranchLineage({ db, threadId, actor: sessionUser }),
    loadThreadAlternativeLinks({ db, threadId, actor: sessionUser }),
  ]);

  return NextResponse.json({ messages: rows, lineage, alternatives });
}
