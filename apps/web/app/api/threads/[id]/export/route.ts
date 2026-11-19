import { chatThreads, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { userScope } from "@/lib/auth/scope";
import {
  buildChatTranscriptMarkdown,
  chatTranscriptFilename,
} from "@/lib/chat-export";
import { loadThreadMessagesWithRunActivity } from "@/lib/thread-messages";
import { loadThreadBranchLineage } from "@/lib/thread-branches";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Markdown export of a thread the caller owns; owner only for every role. */
export async function GET(_req: Request, { params }: RouteContext) {
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

  const [messages, lineage] = await Promise.all([
    loadThreadMessagesWithRunActivity({
      db,
      threadId,
      actor: sessionUser,
    }),
    loadThreadBranchLineage({ db, threadId, actor: sessionUser }),
  ]);
  const title = thread.title ?? "Chat transcript";
  const markdown = buildChatTranscriptMarkdown({
    title,
    threadId,
    lineage,
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
