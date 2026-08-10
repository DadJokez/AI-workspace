import { chatThreads, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/requireSession";
import type { ContextResourceSearchScope } from "@/lib/context-shelf";
import { searchContextResources } from "@/lib/context-shelf-server";

export const dynamic = "force-dynamic";

const MAX_QUERY_CHARS = 200;

export async function GET(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > MAX_QUERY_CHARS) {
    return NextResponse.json(
      { error: "query_too_large", message: "Search is limited to 200 characters." },
      { status: 400 },
    );
  }

  const rawScope = url.searchParams.get("scope") ?? "workspace";
  if (rawScope !== "workspace" && rawScope !== "google_mail") {
    return NextResponse.json({ error: "invalid_scope" }, { status: 400 });
  }
  const scope: ContextResourceSearchScope = rawScope;
  const threadId = url.searchParams.get("threadId")?.trim() || undefined;
  if (threadId && !isUuid(threadId)) {
    return NextResponse.json({ error: "invalid_thread_id" }, { status: 400 });
  }

  const db = getDb();
  if (threadId) {
    const owned = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, session.user.id),
        ),
      )
      .limit(1);
    if (!owned[0]) {
      return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
    }
  }

  try {
    const result = await searchContextResources({
      db,
      user: session.user,
      threadId,
      query,
      scope,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    process.stderr.write(
      `[context-resource-search-error] ${JSON.stringify({
        userId: session.user.id,
        scope,
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    return NextResponse.json(
      {
        error: "context_search_unavailable",
        message: "Selected resources are temporarily unavailable.",
      },
      { status: 502 },
    );
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
