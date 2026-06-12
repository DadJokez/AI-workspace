import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { listAppVersionCandidates } from "@/lib/apps";

export const dynamic = "force-dynamic";

/** Owner-only: the app's deployable version candidates, newest first. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const db = getDb();
  const rows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = rows[0];
  if (
    !app ||
    (app.ownerUserId !== sessionUser.id && sessionUser.role !== "admin")
  ) {
    return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  }

  const candidates = await listAppVersionCandidates(db, {
    ownerUserId: app.ownerUserId,
    sourceThreadId: app.sourceThreadId,
  });

  return NextResponse.json({
    versions: candidates.map((artifact) => ({
      artifactId: artifact.id,
      title: artifact.title,
      filename: artifact.filename,
      sizeBytes: artifact.sizeBytes,
      createdAt: artifact.createdAt,
      isLive: artifact.id === app.liveArtifactId,
      previewUrl: `/api/workspace/artifacts/${artifact.id}`,
    })),
  });
}
