import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/requireSession";
import { checkRateLimit, requestLimitConfig } from "@/lib/request-limits";
import {
  createThreadBranch,
  loadThreadBranchLineage,
  parseThreadBranchRequest,
  ThreadBranchError,
} from "@/lib/thread-branches";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const actor = session.user;
  const db = getDb();
  const limits = requestLimitConfig();
  const rate = await checkRateLimit(db, `thread-branch:${actor.id}`, {
    ...limits,
    maxRequests: Math.min(limits.maxRequests, 20),
  });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many alternate chats were created. Try again shortly.",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "retry-after": String(rate.retryAfterSeconds) },
      },
    );
  }

  try {
    const request = parseThreadBranchRequest(await req.json().catch(() => null));
    const { thread } = await createThreadBranch({ db, actor, request });
    const lineage = await loadThreadBranchLineage({
      db,
      threadId: thread.id,
      actor,
    });
    if (!lineage) {
      throw new Error("Created branch is missing lineage metadata.");
    }
    return NextResponse.json(
      {
        thread: {
          id: thread.id,
          title: thread.title,
          defaultModelId: thread.defaultModelId,
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
        },
        lineage,
        url: `/chat?threadId=${encodeURIComponent(thread.id)}`,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ThreadBranchError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
