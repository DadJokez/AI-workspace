import { AuthConfigError } from "@ai-workspace/auth";
import { chatMessages, chatThreads, getDb } from "@ai-workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/threads/[id]/messages — list messages on a thread.
 *
 * `role = 'user'`  → only messages on a thread the caller owns.
 * `role = 'admin'` → messages on any thread.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      modelId: chatMessages.modelId,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt));

  return NextResponse.json({ messages: rows });
}
