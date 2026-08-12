import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  artifactReviewComments,
  auditLog,
  chatMessages,
  chatThreads,
  createDb,
  runs,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";

const mocks = vi.hoisted(() => ({
  appendRunEvent: vi.fn(),
  checkRateLimit: vi.fn(),
  isModelEnabled: vi.fn(),
  requireSession: vi.fn(),
  startInProcessChatRunWorker: vi.fn(),
}));

vi.mock("@/lib/auth/requireSession", () => ({
  requireSession: mocks.requireSession,
}));
vi.mock("@/lib/chat-run-worker", () => ({
  startInProcessChatRunWorker: mocks.startInProcessChatRunWorker,
}));
vi.mock("@/lib/model-registry", () => ({
  isModelEnabled: mocks.isModelEnabled,
  resolveModelForPurpose: vi.fn().mockResolvedValue("sonnet-4-6"),
}));
vi.mock("@/lib/request-limits", async () => {
  const actual = await vi.importActual<typeof import("@/lib/request-limits")>(
    "@/lib/request-limits",
  );
  return {
    ...actual,
    checkRateLimit: mocks.checkRateLimit,
  };
});
vi.mock("@/lib/run-events", () => ({
  appendRunEvent: mocks.appendRunEvent,
}));

import { POST } from "@/app/api/workspace/artifacts/[id]/review-comments/address/route";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "artifact review Address integration suite: DATABASE_URL is empty in CI.",
  );
}

const suite = describe.skipIf(!DB_URL);
const TEST_PING_SUBJECT = "artifact-review-address-owner";

suite("artifact review Address transaction (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 2 });

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(users).where(eq(users.pingSubject, TEST_PING_SUBJECT));
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.isModelEnabled.mockResolvedValue(true);
    mocks.appendRunEvent.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.pingSubject, TEST_PING_SUBJECT));
  });

  it("creates the run before reserving comments through the immediate foreign key", async () => {
    const [owner] = await db
      .insert(users)
      .values({
        pingSubject: TEST_PING_SUBJECT,
        email: "artifact-review-address@example.com",
        displayName: "Artifact Owner",
        role: "user",
      })
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: owner!.id,
        title: "Review launch brief",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    const [artifact] = await db
      .insert(workspaceArtifacts)
      .values({
        userId: owner!.id,
        threadId: thread!.id,
        title: "Launch brief",
        filename: "launch-brief.md",
        kind: "markdown",
        mimeType: "text/markdown",
        content: "# Launch\n\nShip Friday.",
        sizeBytes: 25,
        source: "assistant-code-block",
      })
      .returning();
    const [comment] = await db
      .insert(artifactReviewComments)
      .values({
        artifactId: artifact!.id,
        artifactOwnerUserId: owner!.id,
        artifactGroupId: artifact!.artifactGroupId,
        artifactVersionNumber: artifact!.versionNumber,
        artifactFilename: artifact!.filename,
        threadId: thread!.id,
        authorUserId: owner!.id,
        authorDisplayName: owner!.displayName,
        body: "Use the approved launch language.",
        anchor: { kind: "artifact" },
      })
      .returning();

    mocks.requireSession.mockResolvedValue({
      user: {
        id: owner!.id,
        email: owner!.email,
        displayName: owner!.displayName,
        role: owner!.role,
      },
    });

    const response = await POST(
      new Request("http://test.local", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: thread!.id,
          modelId: "sonnet-4-6",
          comments: [{ id: comment!.id, revision: comment!.revision }],
        }),
      }),
      { params: Promise.resolve({ id: artifact!.id }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"type":"queued"');

    const [createdRun] = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.threadId, thread!.id),
          eq(runs.triggerType, "artifact_review"),
        ),
      );
    const [reservedComment] = await db
      .select()
      .from(artifactReviewComments)
      .where(eq(artifactReviewComments.id, comment!.id));
    const requestMessages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, thread!.id));
    const requestAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, owner!.id),
          eq(auditLog.actionType, "artifact_review_address_requested"),
        ),
      );

    expect(createdRun).toMatchObject({
      userId: owner!.id,
      threadId: thread!.id,
      triggerType: "artifact_review",
      status: "queued",
    });
    expect(reservedComment).toMatchObject({
      status: "addressing",
      revision: comment!.revision + 1,
      addressingRunId: createdRun!.id,
    });
    expect(requestMessages).toHaveLength(1);
    expect(requestAudits).toHaveLength(1);
    expect(requestAudits[0]).toMatchObject({
      chatThreadId: thread!.id,
      chatMessageId: requestMessages[0]!.id,
      runId: createdRun!.id,
      status: "succeeded",
    });
    expect(mocks.startInProcessChatRunWorker).toHaveBeenCalledWith({
      db: expect.anything(),
      runId: createdRun!.id,
    });
  });
});
