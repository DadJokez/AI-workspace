import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  getStudioBrowserSession,
  stopStudioBrowserSession,
} from "@/lib/studio-browser";
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
  if (!isStudioBrowserId(id)) return invalidId();
  try {
    const browserSession = await getStudioBrowserSession({
      db: getDb(),
      actor: session.user,
      sessionId: id,
    });
    return NextResponse.json({ session: browserSession });
  } catch (error) {
    return studioBrowserApiError(error);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id } = await params;
  if (!isStudioBrowserId(id)) return invalidId();
  try {
    await stopStudioBrowserSession({
      db: getDb(),
      actor: session.user,
      sessionId: id,
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return studioBrowserApiError(error);
  }
}

function invalidId() {
  return NextResponse.json(
    { error: "browser_session_not_found", message: "Browser session not found." },
    { status: 404 },
  );
}
