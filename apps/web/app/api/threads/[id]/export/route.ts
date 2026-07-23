import { chatThreads, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { requireSession } from "@/lib/auth/requireSession";
import { userScope } from "@/lib/auth/scope";
import {
  buildChatTranscriptMarkdown,
  chatTranscriptFilename,
} from "@/lib/chat-export";
import { loadThreadMessagesWithRunActivity } from "@/lib/thread-messages";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: RouteContext) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const { id: threadId } = await params;
  if (!threadId) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      userId: chatThreads.userId,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, threadId),
        userScope(sessionUser, chatThreads.userId),
      ),
    )
    .limit(1);

  const thread = rows[0];
  if (!thread) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  await auditAdminDataAccess({
    db,
    actor: sessionUser,
    access: {
      targetUserId: thread.userId,
      resourceType: "chat_thread",
      resourceId: thread.id,
      surface: "thread_export",
      justification: adminDataAccessJustification(req),
      chatThreadId: thread.id,
    },
  });

  const messages = await loadThreadMessagesWithRunActivity({
    db,
    threadId,
    actor: sessionUser,
  });
  const title = thread.title ?? "Chat transcript";
  const markdown = buildChatTranscriptMarkdown({
    title,
    threadId,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      modelId: message.modelId ?? undefined,
      status: message.status,
      artifacts: message.artifacts,
      activityEvents: message.activityEvents,
      runId: message.runId,
      runStatus: message.runStatus,
      runError: message.runError,
    })),
  });

  return new NextResponse(markdown, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${chatTranscriptFilename({
        title,
      })}"`,
      "cache-control": "no-store",
    },
  });
}
