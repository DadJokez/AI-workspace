import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { runStudioBrowserAction } from "@/lib/studio-browser";
import { studioBrowserApiError } from "@/lib/studio-browser-api";
import {
  isStudioBrowserId,
  parseStudioBrowserAction,
} from "@/lib/studio-browser-contract";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id } = await params;
  if (!isStudioBrowserId(id)) {
    return NextResponse.json({ error: "browser_session_not_found" }, { status: 404 });
  }
  try {
    const action = parseStudioBrowserAction(await req.json());
    await runStudioBrowserAction({
      db: getDb(),
      actor: session.user,
      sessionId: id,
      action,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return NextResponse.json({ error: "invalid_browser_action" }, { status: 400 });
    }
    return studioBrowserApiError(error);
  }
}
