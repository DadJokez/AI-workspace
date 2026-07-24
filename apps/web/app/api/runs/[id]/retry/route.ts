import { UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { retryChatRun } from "@/lib/run-actions";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const session = await requireSession();
    if ("error" in session) return session.error;
    const sessionUser = session.user;
    const result = await retryChatRun({
      db: getDb(),
      actor: sessionUser,
      runId: id,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, message: result.message },
        { status: result.status },
      );
    }
    return NextResponse.json({ run: result.run });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}
