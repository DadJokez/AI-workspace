import { chatThreads, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { requireSession } from "@/lib/auth/requireSession";
import { userScope } from "@/lib/auth/scope";
import { loadThreadMessagesWithRunActivity } from "@/lib/thread-messages";

export const dynamic = "force-dynamic";

/**
 * GET /api/threads/[id]/messages — list messages on a thread.
 *
 * `role = 'user'`  → only messages on a thread the caller owns.
 * `role = 'admin'` → messages on any thread.
 */
export async function GET(
  req: Request,
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
    .select({ id: chatThreads.id, userId: chatThreads.userId })
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

  await auditAdminDataAccess({
    db,
    actor: sessionUser,
    access: {
      targetUserId: owned[0].userId,
      resourceType: "chat_thread",
      resourceId: owned[0].id,
      surface: "thread_messages",
      justification: adminDataAccessJustification(req),
      chatThreadId: owned[0].id,
    },
  });

  const rows = await loadThreadMessagesWithRunActivity({
    db,
    threadId,
    actor: sessionUser,
  });

  return NextResponse.json({ messages: rows });
}
