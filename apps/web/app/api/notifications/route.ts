import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  listNotifications,
  markNotificationsRead,
} from "@/lib/notifications";

export const dynamic = "force-dynamic";

/** The caller's notifications, newest first, plus the unread count. */
export async function GET() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await listNotifications(getDb(), sessionUser.id);
  return NextResponse.json(result);
}

/** Mark notifications read: `{ ids: [...] }` for some, `{ all: true }` for all. */
export async function PATCH(req: Request) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
