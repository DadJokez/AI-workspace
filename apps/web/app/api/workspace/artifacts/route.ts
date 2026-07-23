import { UnauthorizedError } from "@ai-workspace/auth";
import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { loadWorkspaceArtifacts } from "@/lib/workspace-artifacts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession();
    if ("error" in session) return session.error;
    const sessionUser = session.user;

    const url = new URL(req.url);
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const artifacts = await loadWorkspaceArtifacts({
      db: getDb(),
      userId: sessionUser.id,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });

    return NextResponse.json({ artifacts });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }
}
