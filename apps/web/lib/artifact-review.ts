import {
  artifactReviewComments,
  auditLog,
  type ArtifactReviewComment,
  type Database,
  runs,
  type WorkspaceArtifact,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  createTextReviewAnchor,
  resolveTextReviewAnchor,
} from "@/lib/artifact-diff";
import type {
  ArtifactReviewAnchor,
  ArtifactReviewCommentView,
  ArtifactReviewSelection,
} from "@/lib/artifact-review-client";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
export { formatArtifactReviewMessage } from "@/lib/artifact-review-client";
export type {
  ArtifactReviewAnchor,
  ArtifactReviewCommentView,
  ArtifactReviewPermissions,
  ArtifactReviewSelection,
} from "@/lib/artifact-review-client";

export const ARTIFACT_REVIEW_COMMENT_MAX_CHARS = 2_000;
export const ARTIFACT_REVIEW_MAX_SELECTED_COMMENTS = 20;

export interface StoredArtifactReviewComment {
  id: string;
  revision: number;
  body: string;
  anchor: ArtifactReviewAnchor;
  authorDisplayName: string;
}

export interface StoredArtifactReviewRequest {
  runId: string;
  sourceArtifactId: string;
  sourceArtifactGroupId: string;
  sourceArtifactVersionNumber: number;
  sourceArtifactFilename: string;
  sourceThreadId: string;
  requestMessageId: string;
  requestedAt: string;
  requestedByUserId: string;
  comments: StoredArtifactReviewComment[];
}

class ArtifactReviewTransitionConflict extends Error {}

export function normalizeArtifactReviewCommentBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, ARTIFACT_REVIEW_COMMENT_MAX_CHARS);
}

export function parseArtifactReviewSelection(
  value: unknown,
): ArtifactReviewSelection[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > ARTIFACT_REVIEW_MAX_SELECTED_COMMENTS) return null;
  const selections: ArtifactReviewSelection[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const id = nonEmptyString(item.id);
    const revision = positiveInteger(item.revision);
    if (!id || revision === null || ids.has(id)) return null;
    ids.add(id);
    selections.push({ id, revision });
  }
  return selections;
}

export function parseArtifactReviewAnchorForArtifact(
  value: unknown,
  artifact: Pick<WorkspaceArtifact, "content" | "mimeType" | "metadata">,
): ArtifactReviewAnchor | null {
  const anchor = parseArtifactReviewAnchor(value);
  if (!anchor) return null;
  if (anchor.kind === "artifact") return anchor;
  if (!isTextArtifactForReview(artifact)) return null;
  const content = displayArtifactContent(artifact);
  const resolved = resolveTextReviewAnchor(content, anchor);
  if (!resolved || resolved.resolution !== "exact") return null;
  return createTextReviewAnchor(
    content,
    resolved.startOffset,
    resolved.endOffset,
  );
}

export function parseArtifactReviewAnchor(
  value: unknown,
): ArtifactReviewAnchor | null {
  if (!isRecord(value)) return null;
  if (value.kind === "artifact") return { kind: "artifact" };
  if (value.kind !== "text-range") return null;
  const startOffset = nonNegativeInteger(value.startOffset);
  const endOffset = nonNegativeInteger(value.endOffset);
  const quote = boundedString(value.quote, 10_000);
  const prefix = boundedString(value.prefix, 256, true);
  const suffix = boundedString(value.suffix, 256, true);
  if (
    startOffset === null ||
    endOffset === null ||
    endOffset <= startOffset ||
    quote === null ||
    !quote ||
    prefix === null ||
    suffix === null
  ) {
    return null;
  }
  return {
    kind: "text-range",
    startOffset,
    endOffset,
    quote,
    prefix,
    suffix,
  };
}

export function serializeArtifactReviewComment({
  comment,
  actorUserId,
  canAddress,
}: {
  comment: ArtifactReviewComment;
  actorUserId: string;
  canAddress: boolean;
}): ArtifactReviewCommentView {
  const ownsComment = comment.authorUserId === actorUserId;
  const transitionAllowed = ownsComment || canAddress;
  return {
    id: comment.id,
    artifactId: comment.artifactId,
    artifactGroupId: comment.artifactGroupId,
    artifactVersionNumber: comment.artifactVersionNumber,
    artifactFilename: comment.artifactFilename,
    body: comment.body,
    anchor: parseArtifactReviewAnchor(comment.anchor) ?? { kind: "artifact" },
    status: comment.status,
    revision: comment.revision,
    author: {
      id: comment.authorUserId,
      displayName: comment.authorDisplayName,
    },
    addressingRunId: comment.addressingRunId,
    addressedAt: comment.addressedAt?.toISOString() ?? null,
    resultArtifactId: comment.resultArtifactId,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    permissions: {
      canEdit: ownsComment && comment.status !== "addressing",
      canResolve: transitionAllowed && comment.status === "open",
      canReopen: transitionAllowed && comment.status === "addressed",
    },
  };
}

export function artifactReviewRequestFromRunInputs(
  value: unknown,
): StoredArtifactReviewRequest | null {
  if (!isRecord(value) || !isRecord(value.artifactReviewRequest)) return null;
  const request = value.artifactReviewRequest;
  const runId = nonEmptyString(request.runId);
  const sourceArtifactId = nonEmptyString(request.sourceArtifactId);
  const sourceArtifactGroupId = nonEmptyString(request.sourceArtifactGroupId);
  const sourceArtifactVersionNumber = positiveInteger(
    request.sourceArtifactVersionNumber,
  );
  const sourceArtifactFilename = nonEmptyString(request.sourceArtifactFilename);
  const sourceThreadId = nonEmptyString(request.sourceThreadId);
  const requestMessageId = nonEmptyString(request.requestMessageId);
  const requestedAt = nonEmptyString(request.requestedAt);
  const requestedByUserId = nonEmptyString(request.requestedByUserId);
  if (
    !runId ||
    !sourceArtifactId ||
    !sourceArtifactGroupId ||
    sourceArtifactVersionNumber === null ||
    !sourceArtifactFilename ||
    !sourceThreadId ||
    !requestMessageId ||
    !requestedAt ||
    !requestedByUserId ||
    !Array.isArray(request.comments) ||
    request.comments.length === 0 ||
    request.comments.length > ARTIFACT_REVIEW_MAX_SELECTED_COMMENTS
  ) {
    return null;
  }
  const comments: StoredArtifactReviewComment[] = [];
  const ids = new Set<string>();
  for (const item of request.comments) {
    if (!isRecord(item)) return null;
    const id = nonEmptyString(item.id);
    const revision = positiveInteger(item.revision);
    const body = normalizeArtifactReviewCommentBody(item.body);
    const anchor = parseArtifactReviewAnchor(item.anchor);
    const authorDisplayName = nonEmptyString(item.authorDisplayName);
    if (
      !id ||
      ids.has(id) ||
      revision === null ||
      !body ||
      !anchor ||
      !authorDisplayName
    ) {
      return null;
    }
    ids.add(id);
    comments.push({ id, revision, body, anchor, authorDisplayName });
  }
  return {
    runId,
    sourceArtifactId,
    sourceArtifactGroupId,
    sourceArtifactVersionNumber,
    sourceArtifactFilename,
    sourceThreadId,
    requestMessageId,
    requestedAt,
    requestedByUserId,
    comments,
  };
}

export function artifactReviewContextForRequest(
  request: StoredArtifactReviewRequest,
): string {
  const comments = request.comments.map((comment, index) => ({
    number: index + 1,
    id: comment.id,
    author: comment.authorDisplayName,
    body: comment.body,
    anchor: comment.anchor,
  }));
  return [
    `The user selected ${comments.length} review comment${comments.length === 1 ? "" : "s"} for ${request.sourceArtifactFilename} v${request.sourceArtifactVersionNumber}. Apply only this selected feedback to the pinned source artifact. Preserve the filename, return the complete revised artifact, and do not silently include other comments.`,
    `<artifact-review-comments>${JSON.stringify(comments)}</artifact-review-comments>`,
  ].join("\n");
}

export async function completeArtifactReviewRequest({
  db,
  request,
  replacementArtifact,
  completedAt = new Date(),
  expectedWorkerId,
}: {
  db: Database;
  request: StoredArtifactReviewRequest;
  replacementArtifact: WorkspaceArtifactSummary;
  completedAt?: Date;
  expectedWorkerId?: string;
}): Promise<boolean> {
  if (
    replacementArtifact.artifactGroupId !== request.sourceArtifactGroupId ||
    replacementArtifact.supersedesArtifactId !== request.sourceArtifactId
  ) {
    return false;
  }

  try {
    return await db.transaction(async (tx) => {
      if (expectedWorkerId) {
        const ownerRows = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, request.runId),
              eq(runs.status, "running"),
              eq(runs.workerId, expectedWorkerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!ownerRows[0]) throw new ArtifactReviewTransitionConflict();
      }

      const sourceRows = await tx
        .select({ id: workspaceArtifacts.id })
        .from(workspaceArtifacts)
        .where(
          and(
            eq(workspaceArtifacts.id, request.sourceArtifactId),
            eq(
              workspaceArtifacts.artifactGroupId,
              request.sourceArtifactGroupId,
            ),
            eq(
              workspaceArtifacts.versionNumber,
              request.sourceArtifactVersionNumber,
            ),
          ),
        )
        .limit(1)
        .for("update");
      if (!sourceRows[0]) throw new ArtifactReviewTransitionConflict();

      const commentRows = await tx
        .select()
        .from(artifactReviewComments)
        .where(
          and(
            inArray(
              artifactReviewComments.id,
              request.comments.map((comment) => comment.id),
            ),
            eq(artifactReviewComments.status, "addressing"),
            eq(artifactReviewComments.addressingRunId, request.runId),
          ),
        )
        .for("update");
      if (commentRows.length !== request.comments.length) {
        throw new ArtifactReviewTransitionConflict();
      }
      const rowById = new Map(commentRows.map((row) => [row.id, row]));
      for (const comment of request.comments) {
        if (rowById.get(comment.id)?.revision !== comment.revision) {
          throw new ArtifactReviewTransitionConflict();
        }
      }

      const replacementRows = await tx
        .select({ metadata: workspaceArtifacts.metadata })
        .from(workspaceArtifacts)
        .where(
          and(
            eq(workspaceArtifacts.id, replacementArtifact.id),
            eq(workspaceArtifacts.runId, request.runId),
          ),
        )
        .limit(1)
        .for("update");
      if (!replacementRows[0]) throw new ArtifactReviewTransitionConflict();
      const metadata = isRecord(replacementRows[0].metadata)
        ? replacementRows[0].metadata
        : {};
      await tx
        .update(workspaceArtifacts)
        .set({
          metadata: {
            ...metadata,
            artifactReview: {
              sourceArtifactId: request.sourceArtifactId,
              sourceArtifactVersionNumber:
                request.sourceArtifactVersionNumber,
              commentIds: request.comments.map((comment) => comment.id),
              requestedAt: request.requestedAt,
              requestedByUserId: request.requestedByUserId,
              completedAt: completedAt.toISOString(),
            },
          },
          updatedAt: completedAt,
        })
        .where(eq(workspaceArtifacts.id, replacementArtifact.id));

      for (const comment of request.comments) {
        const updated = await tx
          .update(artifactReviewComments)
          .set({
            status: "addressed",
            revision: comment.revision + 1,
            addressingRunId: null,
            addressedByUserId: request.requestedByUserId,
            addressedAt: completedAt,
            resultArtifactId: replacementArtifact.id,
            updatedAt: completedAt,
          })
          .where(
            and(
              eq(artifactReviewComments.id, comment.id),
              eq(artifactReviewComments.status, "addressing"),
              eq(artifactReviewComments.addressingRunId, request.runId),
              eq(artifactReviewComments.revision, comment.revision),
            ),
          )
          .returning({ id: artifactReviewComments.id });
        if (!updated[0]) throw new ArtifactReviewTransitionConflict();
      }

      await tx.insert(auditLog).values({
        actorUserId: request.requestedByUserId,
        actionType: "artifact_review_addressed",
        status: "succeeded",
        provider: "ai-hub",
        toolName: "artifact_review",
        chatThreadId: request.sourceThreadId,
        chatMessageId: request.requestMessageId,
        runId: request.runId,
        input: {
          sourceArtifactId: request.sourceArtifactId,
          commentIds: request.comments.map((comment) => comment.id),
        },
        output: { replacementArtifactId: replacementArtifact.id },
        metadata: {
          sourceArtifactVersionNumber: request.sourceArtifactVersionNumber,
          selectedCommentCount: request.comments.length,
        },
        startedAt: completedAt,
        completedAt,
      });
      return true;
    });
  } catch (error) {
    if (error instanceof ArtifactReviewTransitionConflict) return false;
    throw error;
  }
}

export async function releaseArtifactReviewRequest({
  db,
  request,
  error,
  completedAt = new Date(),
  expectedWorkerId,
  replacementArtifactIds = [],
}: {
  db: Database;
  request: StoredArtifactReviewRequest;
  error: string;
  completedAt?: Date;
  expectedWorkerId?: string;
  replacementArtifactIds?: readonly string[];
}): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      if (expectedWorkerId) {
        const ownerRows = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.id, request.runId),
              eq(runs.status, "running"),
              eq(runs.workerId, expectedWorkerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!ownerRows[0]) throw new ArtifactReviewTransitionConflict();
      }
      if (replacementArtifactIds.length > 0) {
        await tx
          .delete(workspaceArtifacts)
          .where(
            and(
              inArray(workspaceArtifacts.id, [...replacementArtifactIds]),
              eq(workspaceArtifacts.runId, request.runId),
            ),
          );
      }

      let released = 0;
      for (const comment of request.comments) {
        const updated = await tx
          .update(artifactReviewComments)
          .set({
            status: "open",
            revision: comment.revision + 1,
            addressingRunId: null,
            updatedAt: completedAt,
          })
          .where(
            and(
              eq(artifactReviewComments.id, comment.id),
              eq(artifactReviewComments.status, "addressing"),
              eq(artifactReviewComments.addressingRunId, request.runId),
              eq(artifactReviewComments.revision, comment.revision),
            ),
          )
          .returning({ id: artifactReviewComments.id });
        released += updated.length;
      }
      if (released === 0) return false;
      if (released !== request.comments.length) {
        throw new ArtifactReviewTransitionConflict();
      }

      await tx.insert(auditLog).values({
        actorUserId: request.requestedByUserId,
        actionType: "artifact_review_address_failed",
        status: "failed",
        provider: "ai-hub",
        toolName: "artifact_review",
        chatThreadId: request.sourceThreadId,
        chatMessageId: request.requestMessageId,
        runId: request.runId,
        input: {
          sourceArtifactId: request.sourceArtifactId,
          commentIds: request.comments.map((comment) => comment.id),
        },
        error,
        metadata: {
          restoredStatus: "open",
          selectedCommentCount: request.comments.length,
        },
        startedAt: completedAt,
        completedAt,
      });
      return true;
    });
  } catch (transitionError) {
    if (transitionError instanceof ArtifactReviewTransitionConflict) return false;
    throw transitionError;
  }
}

export function isTextArtifactForReview(
  artifact: Pick<WorkspaceArtifact, "mimeType" | "metadata">,
): boolean {
  if (artifact.mimeType.startsWith("text/")) return true;
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : null;
  return metadata?.storageEncoding === "base64" &&
    typeof metadata.extractedText === "string";
}

function displayArtifactContent(
  artifact: Pick<WorkspaceArtifact, "content" | "metadata">,
): string {
  const metadata = isRecord(artifact.metadata) ? artifact.metadata : null;
  return metadata?.storageEncoding === "base64" &&
    typeof metadata.extractedText === "string"
    ? metadata.extractedText
    : artifact.content;
}

function boundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  if (!allowEmpty && !value) return null;
  return value;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
