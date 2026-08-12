import type { ArtifactReviewComment, WorkspaceArtifact } from "@ai-workspace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTextReviewAnchor } from "@/lib/artifact-diff";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getDb: vi.fn(),
  requireSession: vi.fn(),
  resolveArtifactReviewAccess: vi.fn(),
}));

vi.mock("@ai-workspace/db", async () => {
  const actual = await vi.importActual<typeof import("@ai-workspace/db")>(
    "@ai-workspace/db",
  );
  return { ...actual, getDb: mocks.getDb };
});
vi.mock("@/lib/auth/requireSession", () => ({
  requireSession: mocks.requireSession,
}));
vi.mock("@/lib/artifact-review-access", () => ({
  resolveArtifactReviewAccess: mocks.resolveArtifactReviewAccess,
}));
vi.mock("@/lib/request-limits", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

import {
  GET as listComments,
  POST as createComment,
} from "@/app/api/workspace/artifacts/[id]/review-comments/route";
import { PATCH as updateComment } from "@/app/api/workspace/artifacts/[id]/review-comments/[commentId]/route";
import { GET as getCommentLink } from "@/app/api/workspace/artifact-review-comments/[commentId]/route";

const user = {
  id: "user-1",
  email: "rob@example.com",
  displayName: "Rob",
  role: "user" as const,
};
const artifact = artifactRow();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ user });
  mocks.resolveArtifactReviewAccess.mockResolvedValue({
    artifact,
    role: "owner",
    canComment: true,
    canAddress: true,
    app: null,
    appVersion: null,
  });
  mocks.checkRateLimit.mockResolvedValue({
    allowed: true,
    limit: 30,
    remaining: 29,
    resetAt: new Date("2026-08-11T12:01:00.000Z"),
    retryAfterSeconds: 60,
  });
});

describe("artifact review comment API", () => {
  it("hides comments before querying when artifact access was revoked", async () => {
    const db = { select: vi.fn() };
    mocks.getDb.mockReturnValue(db);
    mocks.resolveArtifactReviewAccess.mockResolvedValue(null);

    const response = await listComments(new Request("http://localhost"), {
      params: Promise.resolve({ id: artifact.id }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(db.select).not.toHaveBeenCalled();
  });

  it("creates an attributed, immutable-version comment and audit record", async () => {
    const inserted: unknown[] = [];
    const created = reviewComment();
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce(mutationQuery([created], inserted))
        .mockReturnValueOnce(mutationQuery([], inserted)),
    };
    const db = {
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    mocks.getDb.mockReturnValue(db);
    const content = artifact.content;
    const start = content.indexOf("Review this");
    const anchor = createTextReviewAnchor(
      content,
      start,
      start + "Review this".length,
    );

    const response = await createComment(
      jsonRequest({ body: "  Tighten this.  ", anchor }),
      { params: Promise.resolve({ id: artifact.id }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      db,
      `artifact-review-comment:${user.id}`,
      expect.objectContaining({ windowMs: 60_000, maxRequests: 30 }),
    );
    expect(inserted[0]).toMatchObject({
      artifactId: artifact.id,
      artifactOwnerUserId: artifact.userId,
      artifactVersionNumber: artifact.versionNumber,
      authorUserId: user.id,
      authorDisplayName: user.displayName,
      body: "Tighten this.",
      anchor,
    });
    expect(inserted[1]).toMatchObject({
      actorUserId: user.id,
      actionType: "artifact_review_comment_created",
      status: "succeeded",
    });
  });

  it("uses the reviewer's own bucket for authorized shared comments", async () => {
    const reviewer = { ...user, id: "reviewer-2", displayName: "Avery" };
    const inserted: unknown[] = [];
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce(mutationQuery([reviewComment({
          authorUserId: reviewer.id,
          authorDisplayName: reviewer.displayName,
        })], inserted))
        .mockReturnValueOnce(mutationQuery([], inserted)),
    };
    const db = {
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    mocks.requireSession.mockResolvedValue({ user: reviewer });
    mocks.resolveArtifactReviewAccess.mockResolvedValue({
      artifact,
      role: "viewer",
      canComment: true,
      canAddress: false,
      app: { id: "app-1" },
      appVersion: { id: "version-1" },
    });
    mocks.getDb.mockReturnValue(db);

    const response = await createComment(
      jsonRequest({ body: "Shared review note", anchor: { kind: "artifact" } }),
      { params: Promise.resolve({ id: artifact.id }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      db,
      `artifact-review-comment:${reviewer.id}`,
      expect.any(Object),
    );
  });

  it("returns 429 without comment or audit writes when the bucket is exhausted", async () => {
    const db = { transaction: vi.fn() };
    mocks.getDb.mockReturnValue(db);
    mocks.checkRateLimit.mockResolvedValue({
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAt: new Date("2026-08-11T12:00:42.000Z"),
      retryAfterSeconds: 42,
    });

    const response = await createComment(
      jsonRequest({ body: "One too many", anchor: { kind: "artifact" } }),
      { params: Promise.resolve({ id: artifact.id }) },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toMatchObject({
      error: "rate_limited",
      retryAfterSeconds: 42,
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("fails closed before touching the limiter for unauthorized actors", async () => {
    const db = { transaction: vi.fn() };
    mocks.getDb.mockReturnValue(db);
    mocks.resolveArtifactReviewAccess.mockResolvedValue(null);

    const response = await createComment(
      jsonRequest({ body: "Probe", anchor: { kind: "artifact" } }),
      { params: Promise.resolve({ id: "hidden-artifact" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("returns a visible 409 when optimistic comment revision changed", async () => {
    const existing = reviewComment();
    const tx = {
      update: vi.fn(() => mutationQuery([])),
      insert: vi.fn(),
    };
    const db = {
      select: vi.fn(() => selectQuery([existing])),
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    mocks.getDb.mockReturnValue(db);

    const response = await updateComment(
      jsonRequest({ expectedRevision: existing.revision, body: "New copy" }),
      {
        params: Promise.resolve({
          id: artifact.id,
          commentId: existing.id,
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "comment_changed" });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("does not reveal another reviewer's edit controls", async () => {
    const db = {
      select: vi.fn(() =>
        selectQuery([reviewComment({ authorUserId: "reviewer-2" })]),
      ),
      transaction: vi.fn(),
    };
    mocks.getDb.mockReturnValue(db);
    mocks.resolveArtifactReviewAccess.mockResolvedValue({
      artifact,
      role: "viewer",
      canComment: true,
      canAddress: false,
      app: { id: "app-1" },
      appVersion: { id: "version-1" },
    });

    const response = await updateComment(
      jsonRequest({ expectedRevision: 4, body: "Unauthorized edit" }),
      {
        params: Promise.resolve({ id: artifact.id, commentId: "comment-1" }),
      },
    );

    expect(response.status).toBe(404);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("artifact review deep links", () => {
  it("tells the owner when the immutable source version was deleted", async () => {
    const deleted = reviewComment({ artifactId: null });
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => selectQuery([deleted])),
    });

    const response = await getCommentLink(new Request("http://localhost"), {
      params: Promise.resolve({ commentId: deleted.id }),
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      artifactUnavailable: true,
      artifact: {
        id: null,
        filename: deleted.artifactFilename,
        versionNumber: deleted.artifactVersionNumber,
      },
    });
  });

  it("fails closed when a former recipient loses share permission", async () => {
    const comment = reviewComment({ artifactOwnerUserId: "owner-2" });
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => selectQuery([comment])),
    });
    mocks.resolveArtifactReviewAccess.mockResolvedValue(null);

    const response = await getCommentLink(new Request("http://localhost"), {
      params: Promise.resolve({ commentId: comment.id }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "review_comment_not_found",
    });
  });
});

function jsonRequest(body: unknown) {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function selectQuery<T>(rows: T[]) {
  const resolved = Promise.resolve(rows);
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    for: () => query,
    then: resolved.then.bind(resolved),
  };
  return query;
}

function mutationQuery<T>(rows: T[], captured?: unknown[]) {
  const resolved = Promise.resolve(rows);
  const query = {
    values(value: unknown) {
      captured?.push(value);
      return query;
    },
    set: () => query,
    where: () => query,
    returning: () => resolved,
    then: resolved.then.bind(resolved),
  };
  return query;
}

function artifactRow(): WorkspaceArtifact {
  return {
    id: "artifact-1",
    userId: "user-1",
    threadId: "thread-1",
    chatMessageId: "message-1",
    runId: "run-1",
    title: "Launch brief",
    filename: "launch-brief.md",
    kind: "markdown",
    mimeType: "text/markdown",
    content: "# Launch\n\nReview this paragraph.",
    sizeBytes: 32,
    source: "assistant-code-block",
    artifactGroupId: "artifact-group-1",
    versionNumber: 2,
    supersedesArtifactId: "artifact-0",
    versionSummary: null,
    metadata: {},
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    updatedAt: new Date("2026-08-11T12:00:00.000Z"),
  };
}

function reviewComment(
  overrides: Partial<ArtifactReviewComment> = {},
): ArtifactReviewComment {
  return {
    id: "comment-1",
    artifactId: artifact.id,
    artifactOwnerUserId: artifact.userId,
    artifactGroupId: artifact.artifactGroupId,
    artifactVersionNumber: artifact.versionNumber,
    artifactFilename: artifact.filename,
    threadId: artifact.threadId,
    authorUserId: user.id,
    authorDisplayName: user.displayName,
    body: "Tighten this.",
    anchor: { kind: "artifact" },
    status: "open",
    revision: 4,
    addressingRunId: null,
    addressedByUserId: null,
    addressedAt: null,
    resultArtifactId: null,
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    updatedAt: new Date("2026-08-11T12:00:00.000Z"),
    ...overrides,
  };
}
