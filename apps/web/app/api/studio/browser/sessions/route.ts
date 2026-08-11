import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { studioBrowserApiError } from "@/lib/studio-browser-api";
import { parseStudioBrowserStartRequest } from "@/lib/studio-browser-contract";
import { startStudioBrowserSession } from "@/lib/studio-browser";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  try {
    const input = parseStudioBrowserStartRequest(await req.json());
    const browserSession = await startStudioBrowserSession({
      db: getDb(),
      actor: session.user,
      threadId: input.threadId,
      target: input.target,
    });
    return NextResponse.json({ session: browserSession }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return NextResponse.json(
        { error: "invalid_browser_request", message: "Invalid Browser request." },
        { status: 400 },
      );
    }
    return studioBrowserApiError(error);
  }
}
