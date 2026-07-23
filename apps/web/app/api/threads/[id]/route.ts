import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import { chatThreads, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";
import { loadThreadMessagesWithRunActivity } from "@/lib/thread-messages";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
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

    await auditAdminDataAccess({
      db,
      actor: sessionUser,
      access: {
        targetUserId: owned[0].userId,
        resourceType: "chat_thread",
        resourceId: owned[0].id,
        surface: "thread_detail",
        justification: adminDataAccessJustification(req),
        chatThreadId: owned[0].id,
      },
    });

    const messages = await loadThreadMessagesWithRunActivity({
      db,
      threadId: id,
      actor: sessionUser,
    });

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
 * Update owner-controlled thread metadata. Exactly one field is accepted:
 * `{ title: string }` or `{ pinned: boolean }`. Admins can read workspace
 * threads elsewhere, but personal mutations never cross user boundaries.
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
      | { title?: unknown; pinned?: unknown }
      | null;
    const hasTitle =
      body !== null && Object.prototype.hasOwnProperty.call(body, "title");
    const hasPinned =
      body !== null && Object.prototype.hasOwnProperty.call(body, "pinned");
    if (!body || hasTitle === hasPinned) {
      return NextResponse.json(
        {
          error: "invalid_body",
          message: "provide exactly one of title (string) or pinned (boolean)",
        },
        { status: 400 },
      );
    }

    let updates: {
      title?: string;
      titleSource?: string;
      updatedAt?: Date;
      pinned?: boolean;
    };
    if (hasPinned) {
      if (typeof body.pinned !== "boolean") {
        return NextResponse.json(
          { error: "invalid_pinned", message: "pinned must be a boolean" },
          { status: 400 },
        );
      }
      updates = { pinned: body.pinned };
    } else {
      if (typeof body.title !== "string") {
        return NextResponse.json(
          { error: "invalid_title", message: "title must be a string" },
          { status: 400 },
        );
      }
      const title = body.title.trim().slice(0, MAX_TITLE_LEN);
      if (!title) {
        return NextResponse.json(
          { error: "invalid_title", message: "title cannot be empty" },
          { status: 400 },
        );
      }
      updates = { title, titleSource: "manual", updatedAt: new Date() };
    }

    const db = getDb();
    const updated = await db
      .update(chatThreads)
      .set(updates)
      .where(and(eq(chatThreads.id, id), eq(chatThreads.userId, sessionUser.id)))
      .returning({
        id: chatThreads.id,
        title: chatThreads.title,
        pinned: chatThreads.pinned,
        titleSource: chatThreads.titleSource,
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
