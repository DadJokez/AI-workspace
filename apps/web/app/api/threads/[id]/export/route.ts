import { AuthConfigError } from "@ai-workspace/auth";
import { chatThreads, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";
import {
  buildChatTranscriptMarkdown,
  chatTranscriptFilename,
} from "@/lib/chat-export";
import { loadThreadMessagesWithRunActivity } from "@/lib/thread-messages";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteContext) {
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

  const messages = await loadThreadMessagesWithRunActivity({ db, threadId });
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
