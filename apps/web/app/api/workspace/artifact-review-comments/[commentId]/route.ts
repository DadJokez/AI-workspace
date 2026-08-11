import { artifactReviewComments, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { resolveArtifactReviewAccess } from "@/lib/artifact-review-access";
import { serializeArtifactReviewComment } from "@/lib/artifact-review";

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ commentId: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { commentId } = await params;
  const db = getDb();
  const rows = await db
    .select()
    .from(artifactReviewComments)
    .where(eq(artifactReviewComments.id, commentId))
    .limit(1);
  const comment = rows[0];
  if (!comment) return notFound();

  if (!comment.artifactId) {
    if (comment.artifactOwnerUserId !== session.user.id) return notFound();
    return NextResponse.json(
      {
        artifactUnavailable: true,
        artifact: {
          id: null,
          groupId: comment.artifactGroupId,
          versionNumber: comment.artifactVersionNumber,
          filename: comment.artifactFilename,
        },
        comment: serializeArtifactReviewComment({
          comment,
          actorUserId: session.user.id,
          canAddress: false,
        }),
      },
      { status: 410, headers: PRIVATE_HEADERS },
    );
  }

  const access = await resolveArtifactReviewAccess({
    db,
    actor: session.user,
    artifactId: comment.artifactId,
  });
  if (!access) return notFound();
  return NextResponse.json(
    {
      artifactUnavailable: false,
      artifact: {
        id: access.artifact.id,
        groupId: access.artifact.artifactGroupId,
        versionNumber: access.artifact.versionNumber,
        filename: access.artifact.filename,
      },
      comment: serializeArtifactReviewComment({
        comment,
        actorUserId: session.user.id,
        canAddress: access.canAddress,
      }),
    },
    { headers: PRIVATE_HEADERS },
  );
}

function notFound() {
  return NextResponse.json(
    { error: "review_comment_not_found" },
    { status: 404, headers: PRIVATE_HEADERS },
  );
}
