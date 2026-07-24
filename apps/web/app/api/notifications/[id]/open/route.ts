import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { openNotification } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * The caller opened this notification's run output. Marks it read and
 * records acceptance (first open wins) — the "accepted proactive work"
 * signal behind the north-star metric.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;

  const notification = await openNotification(getDb(), sessionUser.id, id);
  if (!notification) {
    return NextResponse.json({ error: "notification_not_found" }, { status: 404 });
  }
  return NextResponse.json({ notification });
}
