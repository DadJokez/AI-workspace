import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { chatMessages, chatThreads, getDb } from "@ai-workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const db = getDb();

    const owned = await db
      .select()
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, id),
          userScope(sessionUser, chatThreads.userId),
        ),
      )
      .limit(1);
    if (!owned[0]) {
      return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
    }

    const messages = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        modelId: chatMessages.modelId,
        runtime: chatMessages.runtime,
        toolCalls: chatMessages.toolCalls,
        toolResults: chatMessages.toolResults,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, id))
      .orderBy(asc(chatMessages.createdAt));

    return NextResponse.json({ thread: owned[0], messages });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}

const MAX_TITLE_LEN = 200;

/**
 * Rename a thread. Owner-scoped — admins can read everyone's threads but
 * we don't let cross-user renames happen here. Body: `{ title: string }`,
 * trimmed and capped at 200 chars; empty / whitespace-only is rejected.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as
      | { title?: unknown }
      | null;
    const rawTitle = body && typeof body.title === "string" ? body.title : null;
    if (rawTitle === null) {
      return NextResponse.json(
        { error: "invalid_body", message: "title (string) is required" },
        { status: 400 },
      );
    }
    const title = rawTitle.trim().slice(0, MAX_TITLE_LEN);
    if (!title) {
      return NextResponse.json(
        { error: "invalid_title", message: "title cannot be empty" },
        { status: 400 },
      );
    }

    const db = getDb();
    const updated = await db
      .update(chatThreads)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(chatThreads.id, id), eq(chatThreads.userId, sessionUser.id)))
      .returning({
        id: chatThreads.id,
        title: chatThreads.title,
        updatedAt: chatThreads.updatedAt,
      });
    if (!updated[0]) {
      return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
    }
    return NextResponse.json({ thread: updated[0] });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}

/**
 * Thread deletion stays scoped to the owner regardless of role — admin sees
 * everything (read), but moderation-style cross-user deletes belong in a
 * separate admin endpoint with audit logging, not here.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const db = getDb();

    const deleted = await db
      .delete(chatThreads)
      .where(and(eq(chatThreads.id, id), eq(chatThreads.userId, sessionUser.id)))
      .returning({ id: chatThreads.id });
    if (!deleted[0]) {
      return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}
