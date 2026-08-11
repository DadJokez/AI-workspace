import { getDb } from "@ai-workspace/db";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { loadArtifactVersionsForReview } from "@/lib/artifact-review-access";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id } = await params;
  const versionSet = await loadArtifactVersionsForReview({
    db: getDb(),
    actor: session.user,
    artifactId: id,
  });
  if (!versionSet) {
    return NextResponse.json(
      { error: "artifact_not_found" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return NextResponse.json(versionSet, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
