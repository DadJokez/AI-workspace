import type { ArtifactReviewComment, WorkspaceArtifact } from "@ai-workspace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendRunEvent: vi.fn(),
  checkRateLimit: vi.fn(),
  getDb: vi.fn(),
  isModelEnabled: vi.fn(),
  requireSession: vi.fn(),
  resolveArtifactReviewAccess: vi.fn(),
  resolveModelForPurpose: vi.fn(),
  startInProcessChatRunWorker: vi.fn(),
}));

vi.mock("@ai-workspace/db", async () => {
  const actual = await vi.importActual<typeof import("@ai-workspace/db")>(
    "@ai-workspace/db",
  );
  return { ...actual, getDb: mocks.getDb };
});
vi.mock("@ai-workspace/agent", async () => {
  const actual = await vi.importActual<typeof import("@ai-workspace/agent")>(
    "@ai-workspace/agent",
  );
  return {
    ...actual,
    DEFAULT_MODEL_ID: "sonnet-4-5",
    normalizeUserTimeZone: (value: unknown) =>
      value === "America/New_York" ? value : null,
  };
});
vi.mock("@/lib/auth/requireSession", () => ({
  requireSession: mocks.requireSession,
}));
vi.mock("@/lib/artifact-review-access", () => ({
  resolveArtifactReviewAccess: mocks.resolveArtifactReviewAccess,
}));
vi.mock("@/lib/chat-run-worker", () => ({
  startInProcessChatRunWorker: mocks.startInProcessChatRunWorker,
}));
vi.mock("@/lib/model-registry", () => ({
  isModelEnabled: mocks.isModelEnabled,
  resolveModelForPurpose: mocks.resolveModelForPurpose,
}));
vi.mock("@/lib/request-limits", () => ({
  checkRateLimit: mocks.checkRateLimit,
  contentLengthTooLarge: () => false,
  requestLimitConfig: () => ({ maxRequestBytes: 1_000_000 }),
}));
vi.mock("@/lib/run-events", () => ({
  appendRunEvent: mocks.appendRunEvent,
}));

import { POST } from "@/app/api/workspace/artifacts/[id]/review-comments/address/route";

const user = {
  id: "user-1",
  email: "rob@example.com",
  displayName: "Rob",
  role: "user" as const,
};
const artifact = artifactRow();
const thread = {
  id: "thread-1",
  userId: user.id,
  title: "Launch brief review",
};

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
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.isModelEnabled.mockResolvedValue(true);
  mocks.resolveModelForPurpose.mockResolvedValue("sonnet-4-5");
  mocks.appendRunEvent.mockResolvedValue(undefined);
});

describe("POST artifact review Address with Comparative", () => {
  it("reserves exactly the selected revisions in one durable scoped run", async () => {
    const comment = reviewComment();
    const inserts: unknown[] = [];
    const updates: unknown[] = [];
    const tx = transactionHarness({
      selects: [
        [{ id: artifact.id, versionNumber: artifact.versionNumber }],
        [comment],
      ],
      updateResults: [[{ id: comment.id }], []],
      inserts,
      updates,
    });
    const db = {
      select: vi.fn(() => selectQuery([thread])),
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    mocks.getDb.mockReturnValue(db);

    const response = await addressRequest([
      { id: comment.id, revision: comment.revision },
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain('"type":"queued"');
    expect(updates[0]).toMatchObject({
      status: "addressing",
      revision: comment.revision + 1,
    });
    const runInsert = inserts.find(
      (value) =>
        isRecord(value) && value.triggerType === "artifact_review",
    ) as Record<string, unknown>;
    const inputs = runInsert.inputs as Record<string, unknown>;
    const stored = inputs.artifactReviewRequest as Record<string, unknown>;
    expect(runInsert).toMatchObject({
      userId: user.id,
      threadId: thread.id,
      status: "queued",
      modelId: "sonnet-4-5",
    });
    expect(inputs).toMatchObject({
      executionMode: "local",
      userTimeZone: "America/New_York",
      artifactContextTarget: {
        id: artifact.id,
        artifactGroupId: artifact.artifactGroupId,
        versionNumber: artifact.versionNumber,
      },
    });
    expect(stored.runId).toBe(runInsert.id);
    expect(stored.comments).toEqual([
      {
        id: comment.id,
        revision: comment.revision + 1,
        body: comment.body,
        anchor: comment.anchor,
        authorDisplayName: comment.authorDisplayName,
      },
    ]);
    expect(mocks.startInProcessChatRunWorker).toHaveBeenCalledWith({
      db,
      runId: runInsert.id,
    });
  });

  it("rejects a stale artifact base before reserving comments", async () => {
    const inserts: unknown[] = [];
    const tx = transactionHarness({
      selects: [[{ id: "artifact-v3", versionNumber: 3 }]],
      updateResults: [],
      inserts,
      updates: [],
    });
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => selectQuery([thread])),
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    });

    const response = await addressRequest([
      { id: "comment-1", revision: 4 },
    ]);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "artifact_stale_base",
    });
    expect(inserts).toEqual([]);
    expect(mocks.startInProcessChatRunWorker).not.toHaveBeenCalled();
  });

  it("rejects a concurrent comment edit without creating a run", async () => {
    const comment = reviewComment({ revision: 5 });
    const inserts: unknown[] = [];
    const tx = transactionHarness({
      selects: [
        [{ id: artifact.id, versionNumber: artifact.versionNumber }],
        [comment],
      ],
      updateResults: [],
      inserts,
      updates: [],
    });
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => selectQuery([thread])),
      transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    });

    const response = await addressRequest([
      { id: comment.id, revision: 4 },
    ]);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "comment_changed" });
    expect(inserts).toEqual([]);
  });
});

function addressRequest(comments: Array<{ id: string; revision: number }>) {
  return POST(
    new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: thread.id,
        comments,
        timeZone: "America/New_York",
      }),
    }),
    { params: Promise.resolve({ id: artifact.id }) },
  );
}

function transactionHarness({
  selects,
  updateResults,
  inserts,
  updates,
}: {
  selects: unknown[][];
  updateResults: unknown[][];
  inserts: unknown[];
  updates: unknown[];
}) {
  let selectIndex = 0;
  let updateIndex = 0;
  return {
    select: vi.fn(() => selectQuery(selects[selectIndex++] ?? [])),
    insert: vi.fn(() => mutationQuery([], inserts)),
    update: vi.fn(() =>
      mutationQuery(updateResults[updateIndex++] ?? [], updates),
    ),
  };
}

function selectQuery<T>(rows: T[]) {
  const resolved = Promise.resolve(rows);
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    for: () => query,
    then: resolved.then.bind(resolved),
  };
  return query;
}

function mutationQuery<T>(rows: T[], captured: unknown[]) {
  const resolved = Promise.resolve(rows);
  const query = {
    values(value: unknown) {
      captured.push(value);
      return query;
    },
    set(value: unknown) {
      captured.push(value);
      return query;
    },
    where: () => query,
    returning: () => resolved,
    then: resolved.then.bind(resolved),
  };
  return query;
}

function artifactRow(): WorkspaceArtifact {
  return {
    id: "artifact-v2",
    userId: user.id,
    threadId: "thread-1",
    chatMessageId: "message-1",
    runId: "run-source",
    title: "Launch brief",
    filename: "launch-brief.md",
    kind: "markdown",
    mimeType: "text/markdown",
    content: "# Launch\n\nShip Friday.",
    sizeBytes: 25,
    source: "assistant-code-block",
    artifactGroupId: "artifact-group-1",
    versionNumber: 2,
    supersedesArtifactId: "artifact-v1",
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
    authorUserId: "reviewer-1",
    authorDisplayName: "Avery Reviewer",
    body: "Use the approved launch language.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
