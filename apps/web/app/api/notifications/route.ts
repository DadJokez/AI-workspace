import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  listNotifications,
  markNotificationsRead,
} from "@/lib/notifications";

export const dynamic = "force-dynamic";

/** The caller's notifications, newest first, plus the unread count. */
export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  const result = await listNotifications(getDb(), sessionUser.id);
  return NextResponse.json(result);
}

/** Mark notifications read: `{ ids: [...] }` for some, `{ all: true }` for all. */
export async function PATCH(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { ids, all } = body as { ids?: unknown; all?: unknown };
  if (all === true) {
    await markNotificationsRead(getDb(), sessionUser.id);
  } else if (
    Array.isArray(ids) &&
    ids.every((id): id is string => typeof id === "string")
  ) {
    await markNotificationsRead(getDb(), sessionUser.id, ids);
  } else {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
