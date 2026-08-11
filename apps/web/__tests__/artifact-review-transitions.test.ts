import type {
  ArtifactReviewComment,
  Database,
} from "@ai-workspace/db";
import { describe, expect, it, vi } from "vitest";
import {
  completeArtifactReviewRequest,
  releaseArtifactReviewRequest,
  type StoredArtifactReviewRequest,
} from "@/lib/artifact-review";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

describe("artifact review run transitions", () => {
  it("atomically links a replacement to its selected comments", async () => {
    const request = storedRequest();
    const harness = transitionHarness({
      selects: [
        [{ id: request.runId }],
        [{ id: request.sourceArtifactId }],
        [reviewComment()],
        [{ metadata: { outputProposal: { status: "proposed" } } }],
      ],
      updateResults: [[], [{ id: request.comments[0]!.id }]],
    });
    const completedAt = new Date("2026-08-11T13:00:00.000Z");

    const completed = await completeArtifactReviewRequest({
      db: harness.db,
      request,
      replacementArtifact: replacementArtifact(),
      completedAt,
      expectedWorkerId: "worker-1",
    });

    expect(completed).toBe(true);
    expect(harness.sets[0]).toMatchObject({
      metadata: {
        outputProposal: { status: "proposed" },
        artifactReview: {
          sourceArtifactId: request.sourceArtifactId,
          sourceArtifactVersionNumber: request.sourceArtifactVersionNumber,
          commentIds: [request.comments[0]!.id],
          completedAt: completedAt.toISOString(),
        },
      },
    });
    expect(harness.sets[1]).toMatchObject({
      status: "addressed",
      revision: request.comments[0]!.revision + 1,
      addressingRunId: null,
      resultArtifactId: "artifact-v3",
    });
    expect(harness.inserts).toContainEqual(
      expect.objectContaining({
        actionType: "artifact_review_addressed",
        runId: request.runId,
        output: { replacementArtifactId: "artifact-v3" },
      }),
    );
  });

  it("rejects completion when the worker no longer owns the run", async () => {
    const harness = transitionHarness({ selects: [[]] });

    const completed = await completeArtifactReviewRequest({
      db: harness.db,
      request: storedRequest(),
      replacementArtifact: replacementArtifact(),
      expectedWorkerId: "stale-worker",
    });

    expect(completed).toBe(false);
    expect(harness.sets).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("removes failed output and reopens every reserved comment", async () => {
    const request = storedRequest();
    const harness = transitionHarness({
      selects: [[{ id: request.runId }]],
      updateResults: [[{ id: request.comments[0]!.id }]],
    });

    const released = await releaseArtifactReviewRequest({
      db: harness.db,
      request,
      error: "The run did not create a valid replacement.",
      expectedWorkerId: "worker-1",
      replacementArtifactIds: ["invalid-artifact"],
    });

    expect(released).toBe(true);
    expect(harness.deleteCount).toBe(1);
    expect(harness.sets[0]).toMatchObject({
      status: "open",
      revision: request.comments[0]!.revision + 1,
      addressingRunId: null,
    });
    expect(harness.inserts).toContainEqual(
      expect.objectContaining({
        actionType: "artifact_review_address_failed",
        status: "failed",
        error: "The run did not create a valid replacement.",
      }),
    );
  });
});

function transitionHarness({
  selects,
  updateResults = [],
}: {
  selects: unknown[][];
  updateResults?: unknown[][];
}) {
  let selectIndex = 0;
  let updateIndex = 0;
  const sets: unknown[] = [];
  const inserts: unknown[] = [];
  let deleteCount = 0;
  const tx = {
    select: vi.fn(() => selectQuery(selects[selectIndex++] ?? [])),
    update: vi.fn(() =>
      mutationQuery(updateResults[updateIndex++] ?? [], sets, "set"),
    ),
    insert: vi.fn(() => mutationQuery([], inserts, "values")),
    delete: vi.fn(() => {
      deleteCount += 1;
      return mutationQuery([], [], "none");
    }),
  };
  const db = {
    transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as Database;
  return {
    db,
    sets,
    inserts,
    get deleteCount() {
      return deleteCount;
    },
  };
}

function selectQuery<T>(rows: T[]) {
  const resolved = Promise.resolve(rows);
  const query = {
    from: () => query,
    where: () => query,
    limit: () => query,
    for: () => query,
    then: resolved.then.bind(resolved),
  };
  return query;
}

function mutationQuery<T>(
  rows: T[],
  captured: unknown[],
  capture: "set" | "values" | "none",
) {
  const resolved = Promise.resolve(rows);
  const query = {
    set(value: unknown) {
      if (capture === "set") captured.push(value);
      return query;
    },
    values(value: unknown) {
      if (capture === "values") captured.push(value);
      return query;
    },
    where: () => query,
    returning: () => resolved,
    then: resolved.then.bind(resolved),
  };
  return query;
}

function storedRequest(): StoredArtifactReviewRequest {
  return {
    runId: "run-review-1",
    sourceArtifactId: "artifact-v2",
    sourceArtifactGroupId: "artifact-group-1",
    sourceArtifactVersionNumber: 2,
    sourceArtifactFilename: "launch-brief.md",
    sourceThreadId: "thread-1",
    requestMessageId: "message-review-1",
    requestedAt: "2026-08-11T12:30:00.000Z",
    requestedByUserId: "owner-1",
    comments: [
      {
        id: "comment-1",
        revision: 5,
        body: "Mention the approval gate.",
        anchor: { kind: "artifact" },
        authorDisplayName: "Avery Reviewer",
      },
    ],
  };
}

function reviewComment(): ArtifactReviewComment {
  const request = storedRequest();
  return {
    id: request.comments[0]!.id,
    artifactId: request.sourceArtifactId,
    artifactOwnerUserId: "owner-1",
    artifactGroupId: request.sourceArtifactGroupId,
    artifactVersionNumber: request.sourceArtifactVersionNumber,
    artifactFilename: request.sourceArtifactFilename,
    threadId: request.sourceThreadId,
    authorUserId: "reviewer-1",
    authorDisplayName: request.comments[0]!.authorDisplayName,
    body: request.comments[0]!.body,
    anchor: request.comments[0]!.anchor,
    status: "addressing",
    revision: request.comments[0]!.revision,
    addressingRunId: request.runId,
    addressedByUserId: null,
    addressedAt: null,
    resultArtifactId: null,
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    updatedAt: new Date("2026-08-11T12:30:00.000Z"),
  };
}

function replacementArtifact(): WorkspaceArtifactSummary {
  return {
    id: "artifact-v3",
    title: "Launch brief",
    filename: "launch-brief.md",
    kind: "markdown",
    mimeType: "text/markdown",
    sizeBytes: 64,
    source: "assistant-code-block",
    threadId: "thread-1",
    chatMessageId: "assistant-review-1",
    runId: "run-review-1",
    artifactGroupId: "artifact-group-1",
    versionNumber: 3,
    supersedesArtifactId: "artifact-v2",
    versionSummary: "Applied one selected review comment.",
    metadata: { outputProposal: { status: "proposed" } },
    createdAt: "2026-08-11T13:00:00.000Z",
    previewUrl: "/workspace/artifacts/artifact-v3",
    downloadUrl: "/api/workspace/artifacts/artifact-v3/download",
  };
}
