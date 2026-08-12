import {
  artifactReviewComments,
  auditLog,
  getDb,
} from "@ai-workspace/db";
import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { resolveArtifactReviewAccess } from "@/lib/artifact-review-access";
import {
  ARTIFACT_REVIEW_COMMENT_MAX_CHARS,
  normalizeArtifactReviewCommentBody,
  parseArtifactReviewAnchorForArtifact,
  serializeArtifactReviewComment,
} from "@/lib/artifact-review";
import {
  checkRateLimit,
  contentLengthTooLarge,
  type RequestLimitConfig,
} from "@/lib/request-limits";

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };
const REVIEW_COMMENT_RATE_LIMIT = {
  maxRequestBytes: 32 * 1024,
  maxMessageChars: ARTIFACT_REVIEW_COMMENT_MAX_CHARS,
  windowMs: 60_000,
  maxRequests: 30,
} satisfies RequestLimitConfig;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id } = await params;
  const db = getDb();
  const access = await resolveArtifactReviewAccess({
    db,
    actor: session.user,
    artifactId: id,
  });
  if (!access) return notFound();

  const rows = await db
    .select()
    .from(artifactReviewComments)
    .where(eq(artifactReviewComments.artifactId, access.artifact.id))
    .orderBy(asc(artifactReviewComments.createdAt));
  return NextResponse.json(
    {
      artifactId: access.artifact.id,
      artifactVersionNumber: access.artifact.versionNumber,
      permissions: {
        canComment: access.canComment,
        canAddress: access.canAddress,
      },
      comments: rows.map((comment) =>
        serializeArtifactReviewComment({
          comment,
          actorUserId: session.user.id,
          canAddress: access.canAddress,
        }),
      ),
    },
    { headers: PRIVATE_HEADERS },
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const { id } = await params;
  const db = getDb();
  const access = await resolveArtifactReviewAccess({
    db,
    actor: session.user,
    artifactId: id,
  });
  if (!access) return notFound();
  if (!access.canComment) return notFound();
  if (
    contentLengthTooLarge(
      req.headers,
      REVIEW_COMMENT_RATE_LIMIT.maxRequestBytes,
    )
  ) {
    return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  }
  const rate = await checkRateLimit(
    db,
    `artifact-review-comment:${session.user.id}`,
    REVIEW_COMMENT_RATE_LIMIT,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many review comments. Please wait a moment and try again.",
        retryAfterSeconds: rate.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          ...PRIVATE_HEADERS,
          "Retry-After": String(rate.retryAfterSeconds),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
          "X-RateLimit-Reset": rate.resetAt.toISOString(),
        },
      },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = (await req.json()) as unknown;
    if (!isRecord(parsed)) throw new Error("invalid");
    body = parsed;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const commentBody = normalizeArtifactReviewCommentBody(body.body);
  const anchor = parseArtifactReviewAnchorForArtifact(
    body.anchor,
    access.artifact,
  );
  if (!commentBody || !anchor) {
    return NextResponse.json(
      {
        error: "invalid_review_comment",
        message: "Add a comment and choose a valid location in this version.",
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(artifactReviewComments)
      .values({
        artifactId: access.artifact.id,
        artifactOwnerUserId: access.artifact.userId,
        artifactGroupId: access.artifact.artifactGroupId,
        artifactVersionNumber: access.artifact.versionNumber,
        artifactFilename: access.artifact.filename,
        threadId:
          access.artifact.userId === session.user.id
            ? access.artifact.threadId
            : null,
        authorUserId: session.user.id,
        authorDisplayName: session.user.displayName,
        body: commentBody,
        anchor,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const comment = rows[0]!;
    await tx.insert(auditLog).values({
      actorUserId: session.user.id,
      actionType: "artifact_review_comment_created",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "artifact_review",
      chatThreadId: comment.threadId,
      input: {
        artifactId: access.artifact.id,
        commentId: comment.id,
      },
      metadata: {
        artifactVersionNumber: access.artifact.versionNumber,
        anchorKind: anchor.kind,
        bodyChars: commentBody.length,
      },
      startedAt: now,
      completedAt: now,
    });
    return comment;
  });

  return NextResponse.json(
    {
      comment: serializeArtifactReviewComment({
        comment: created,
        actorUserId: session.user.id,
        canAddress: access.canAddress,
      }),
    },
    { status: 201, headers: PRIVATE_HEADERS },
  );
}

function notFound() {
  return NextResponse.json(
    { error: "artifact_not_found" },
    { status: 404, headers: PRIVATE_HEADERS },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
