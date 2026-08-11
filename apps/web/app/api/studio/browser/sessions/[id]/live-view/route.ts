import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { getStudioBrowserLiveView } from "@/lib/studio-browser";
import { studioBrowserApiError } from "@/lib/studio-browser-api";
import { isStudioBrowserId } from "@/lib/studio-browser-contract";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id } = await params;
  if (!isStudioBrowserId(id)) {
    return NextResponse.json({ error: "browser_session_not_found" }, { status: 404 });
  }
  try {
    const liveView = await getStudioBrowserLiveView({
      db: getDb(),
      actor: session.user,
      sessionId: id,
    });
    return NextResponse.json({ liveView });
  } catch (error) {
    return studioBrowserApiError(error);
  }
}
