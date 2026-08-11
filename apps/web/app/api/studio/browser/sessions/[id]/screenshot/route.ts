import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { getStudioBrowserScreenshot } from "@/lib/studio-browser";
import { studioBrowserApiError } from "@/lib/studio-browser-api";
import { isStudioBrowserId } from "@/lib/studio-browser-contract";

export const dynamic = "force-dynamic";

export async function GET(
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
    const screenshot = await getStudioBrowserScreenshot({
      db: getDb(),
      actor: session.user,
      sessionId: id,
    });
    return new NextResponse(Uint8Array.from(screenshot).buffer, {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return studioBrowserApiError(error);
  }
}
