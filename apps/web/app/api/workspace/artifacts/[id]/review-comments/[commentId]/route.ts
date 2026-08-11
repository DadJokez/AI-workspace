import {
  artifactReviewComments,
  auditLog,
  getDb,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { resolveArtifactReviewAccess } from "@/lib/artifact-review-access";
import {
  normalizeArtifactReviewCommentBody,
  serializeArtifactReviewComment,
} from "@/lib/artifact-review";

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

export async function PATCH(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; commentId: string }>;
  },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id, commentId } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await req.json()) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const expectedRevision = positiveInteger(body.expectedRevision);
  const requestedStatus =
    body.status === "open" || body.status === "addressed"
      ? body.status
      : null;
  const includesBody = Object.prototype.hasOwnProperty.call(body, "body");
  const nextBody = includesBody
    ? normalizeArtifactReviewCommentBody(body.body)
    : undefined;
  if (
    expectedRevision === null ||
    (!includesBody && !requestedStatus) ||
    (includesBody && !nextBody)
  ) {
    return NextResponse.json(
      {
        error: "invalid_review_comment_update",
        message: "The comment changed or the requested update is invalid.",
      },
      { status: 400 },
    );
  }

  const db = getDb();
  const access = await resolveArtifactReviewAccess({
    db,
    actor: session.user,
    artifactId: id,
  });
  if (!access) return notFound();
  const existingRows = await db
    .select()
    .from(artifactReviewComments)
    .where(
      and(
        eq(artifactReviewComments.id, commentId),
        eq(artifactReviewComments.artifactId, access.artifact.id),
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return notFound();
  const ownsComment = existing.authorUserId === session.user.id;
  if (existing.status === "addressing") {
    return NextResponse.json(
      {
        error: "comment_addressing",
        message: "This comment is currently being addressed.",
      },
      { status: 409, headers: PRIVATE_HEADERS },
    );
  }
  if (includesBody && !ownsComment) return notFound();
  if (requestedStatus && !ownsComment && !access.canAddress) return notFound();
  if (
    requestedStatus &&
    !(
      (existing.status === "open" && requestedStatus === "addressed") ||
      (existing.status === "addressed" && requestedStatus === "open")
    )
  ) {
    return NextResponse.json(
      { error: "invalid_comment_transition" },
      { status: 409, headers: PRIVATE_HEADERS },
    );
  }

  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(artifactReviewComments)
      .set({
        ...(nextBody ? { body: nextBody } : {}),
        ...(requestedStatus
          ? requestedStatus === "addressed"
            ? {
                status: "addressed" as const,
                addressedByUserId: session.user.id,
                addressedAt: now,
                resultArtifactId: null,
              }
            : {
                status: "open" as const,
                addressingRunId: null,
                addressedByUserId: null,
                addressedAt: null,
                resultArtifactId: null,
              }
          : {}),
        revision: expectedRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(artifactReviewComments.id, existing.id),
          eq(artifactReviewComments.artifactId, access.artifact.id),
          eq(artifactReviewComments.revision, expectedRevision),
          eq(artifactReviewComments.status, existing.status),
        ),
      )
      .returning();
    const comment = rows[0];
    if (!comment) return null;
    await tx.insert(auditLog).values({
      actorUserId: session.user.id,
      actionType: requestedStatus
        ? requestedStatus === "addressed"
          ? "artifact_review_comment_resolved"
          : "artifact_review_comment_reopened"
        : "artifact_review_comment_edited",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "artifact_review",
      chatThreadId: comment.threadId,
      input: {
        artifactId: access.artifact.id,
        commentId: comment.id,
        expectedRevision,
      },
      metadata: {
        previousStatus: existing.status,
        status: comment.status,
        bodyEdited: includesBody,
      },
      startedAt: now,
      completedAt: now,
    });
    return comment;
  });
  if (!updated) {
    return NextResponse.json(
      {
        error: "comment_changed",
        message: "This comment changed. Reload it before trying again.",
      },
      { status: 409, headers: PRIVATE_HEADERS },
    );
  }
  return NextResponse.json(
    {
      comment: serializeArtifactReviewComment({
        comment: updated,
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

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
