import { randomUUID } from "node:crypto";

import type { SessionUser } from "@ai-workspace/auth";
import {
  apps,
  appVersions,
  auditLog,
  chatMessages,
  chatThreadBranches,
  chatThreads,
  createDb,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withOutputProposal } from "@/lib/output-proposals";
import {
  createThreadBranch,
  loadThreadAlternativeLinks,
  loadThreadBranchArtifactContext,
  loadThreadBranchLineage,
  loadThreadPromptHistory,
  type ThreadBranchSnapshotV1,
} from "@/lib/thread-branches";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "thread branch integration suite: DATABASE_URL is empty in CI; refusing to green-by-skip.",
  );
}

const suite = describe.skipIf(!DB_URL);

suite("thread branch isolation (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 6 });
  let alice: SessionUser;
  let bob: SessionUser;

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    await db.delete(auditLog);
    await db.delete(users);
    const [aliceRow, bobRow] = await db
      .insert(users)
      .values([
        {
          pingSubject: `branch-alice-${randomUUID()}`,
          email: `branch-alice-${randomUUID()}@example.com`,
          displayName: "Alice",
          role: "user",
        },
        {
          pingSubject: `branch-bob-${randomUUID()}`,
          email: `branch-bob-${randomUUID()}@example.com`,
          displayName: "Bob",
          role: "user",
        },
      ])
      .returning();
    alice = asSession(aliceRow!);
    bob = asSession(bobRow!);
  });

  afterAll(async () => {
    await db.delete(auditLog);
    await db.delete(users);
  });

  it("copies the selected history exactly once and isolates later work", async () => {
    const [source] = await db
      .insert(chatThreads)
      .values({
        userId: alice.id,
        title: "Quarterly launch plan",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    const first = await insertMessage(source!.id, "user", "Build the launch plan", 0);
    const branchPoint = await insertMessage(
      source!.id,
      "assistant",
      "Here is the first approach",
      1,
      { toolCalls: [{ id: "call-1" }], toolResults: [{ id: "result-1" }] },
    );
    await insertMessage(source!.id, "tool", "stale tool output", 2);
    const later = await insertMessage(source!.id, "user", "Now replace it", 3);

    const upload = await insertArtifact({
      userId: alice.id,
      threadId: source!.id,
      messageId: first.id,
      filename: "launch-input.csv",
      source: "user-upload",
    });
    const completed = await insertArtifact({
      userId: alice.id,
      threadId: source!.id,
      messageId: branchPoint.id,
      filename: "launch-plan.md",
    });
    const pendingProposal = await insertArtifact({
      userId: alice.id,
      threadId: source!.id,
      messageId: branchPoint.id,
      filename: "pending-proposal.md",
      metadata: withOutputProposal({}, {
        runId: randomUUID(),
        triggerType: "scheduled",
        createdAt: new Date().toISOString(),
      }),
    });
    const pendingDraft = await insertArtifact({
      userId: alice.id,
      threadId: source!.id,
      messageId: branchPoint.id,
      filename: "pending-app.html",
      mimeType: "text/html",
    });
    const [app] = await db
      .insert(apps)
      .values({
        slug: `branch-app-${randomUUID()}`,
        name: "Pending app",
        ownerUserId: alice.id,
        sourceThreadId: source!.id,
      })
      .returning();
    await db.insert(appVersions).values({
      appId: app!.id,
      artifactId: pendingDraft.id,
      versionNumber: 1,
      status: "proposed",
      createdByUserId: alice.id,
      sourceThreadId: source!.id,
    });
    const laterArtifact = await insertArtifact({
      userId: alice.id,
      threadId: source!.id,
      messageId: later.id,
      filename: "replacement.md",
    });

    const { thread: branch, snapshot } = await createThreadBranch({
      db,
      actor: alice,
      request: {
        sourceType: "message",
        sourceThreadId: source!.id,
        sourceMessageId: branchPoint.id,
      },
    });

    expect(snapshot.messages.map((message) => message.content)).toEqual([
      "Build the launch plan",
      "Here is the first approach",
    ]);
    expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(2);
    expect(snapshot.messages.every((message) => message.role !== "tool")).toBe(true);
    expect(snapshot.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ toolCalls: expect.anything() })]),
    );
    expect(snapshot.resources.map((resource) => resource.artifactIdSnapshot).sort()).toEqual(
      [upload.id, completed.id].sort(),
    );
    expect(snapshot.resources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactIdSnapshot: pendingProposal.id }),
        expect.objectContaining({ artifactIdSnapshot: pendingDraft.id }),
        expect.objectContaining({ artifactIdSnapshot: laterArtifact.id }),
      ]),
    );

    const branchMessage = await insertMessage(
      branch.id,
      "user",
      "Explore the customer story instead",
      10,
    );
    await insertMessage(source!.id, "user", "Source-only follow-up", 11);
    const [sourceHistory, branchHistory] = await Promise.all([
      loadThreadPromptHistory({ db, threadId: source!.id }),
      loadThreadPromptHistory({ db, threadId: branch.id }),
    ]);
    expect(sourceHistory.map((message) => message.content)).toContain(
      "Source-only follow-up",
    );
    expect(sourceHistory.map((message) => message.content)).not.toContain(
      branchMessage.content,
    );
    expect(branchHistory.map((message) => message.content)).toEqual([
      "Build the launch plan",
      "Here is the first approach",
      "Explore the customer story instead",
    ]);
    await expect(
      loadThreadAlternativeLinks({
        db,
        threadId: source!.id,
        actor: alice,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        threadId: branch.id,
        title: "Alternative: Quarterly launch plan",
        sourceType: "message",
      }),
    ]);
    await expect(
      loadThreadAlternativeLinks({
        db,
        threadId: source!.id,
        actor: bob,
      }),
    ).resolves.toEqual([]);

    await expect(
      createThreadBranch({
        db,
        actor: bob,
        request: { sourceType: "thread", sourceThreadId: source!.id },
      }),
    ).rejects.toMatchObject({ code: "branch_source_not_found", status: 404 });

    await db.delete(chatThreads).where(eq(chatThreads.id, source!.id));
    const [storedBranch] = await db
      .select()
      .from(chatThreadBranches)
      .where(eq(chatThreadBranches.threadId, branch.id));
    const lineage = await loadThreadBranchLineage({
      db,
      threadId: branch.id,
      actor: alice,
    });
    expect(storedBranch?.parentThreadId).toBeNull();
    expect(storedBranch?.parentThreadIdSnapshot).toBe(source!.id);
    expect(lineage?.parentThreadId).toBeNull();
    expect(lineage?.parentThreadIdSnapshot).toBe(source!.id);
    await expect(
      loadThreadPromptHistory({ db, threadId: branch.id }),
    ).resolves.toHaveLength(3);
  });

  it("pins an artifact, rechecks access, and stops targeting the source after branch output", async () => {
    const { threadId, messageId } = await seedSimpleThread();
    const sourceArtifact = await insertArtifact({
      userId: alice.id,
      threadId,
      messageId,
      filename: "strategy.md",
      content: "# Strategy\nOriginal direction",
    });
    const { thread: branch } = await createThreadBranch({
      db,
      actor: alice,
      request: {
        sourceType: "artifact",
        sourceThreadId: threadId,
        artifactId: sourceArtifact.id,
      },
    });

    const available = await loadThreadBranchArtifactContext({
      db,
      threadId: branch.id,
      actor: alice,
    });
    expect(available?.text).toContain("Original direction");
    expect(available?.separateFromArtifact?.id).toBe(sourceArtifact.id);

    await db
      .update(workspaceArtifacts)
      .set({ userId: bob.id })
      .where(eq(workspaceArtifacts.id, sourceArtifact.id));
    const revoked = await loadThreadBranchArtifactContext({
      db,
      threadId: branch.id,
      actor: alice,
    });
    const lineage = await loadThreadBranchLineage({
      db,
      threadId: branch.id,
      actor: alice,
    });
    expect(revoked?.text).toContain("unavailable or access was revoked");
    expect(revoked?.separateFromArtifact).toBeNull();
    expect(lineage?.resources[0]?.status).toBe("unavailable");

    await db
      .update(workspaceArtifacts)
      .set({ userId: alice.id })
      .where(eq(workspaceArtifacts.id, sourceArtifact.id));
    const branchOutput = await insertMessage(
      branch.id,
      "assistant",
      "Created a distinct alternative",
      20,
    );
    await insertArtifact({
      userId: alice.id,
      threadId: branch.id,
      messageId: branchOutput.id,
      filename: "strategy-alternative.md",
    });
    await expect(
      loadThreadBranchArtifactContext({ db, threadId: branch.id, actor: alice }),
    ).resolves.toBeNull();
  });

  it("keeps an explicitly selected pending app version as the branch source", async () => {
    const { threadId, messageId } = await seedSimpleThread();
    const artifact = await insertArtifact({
      userId: alice.id,
      threadId,
      messageId,
      filename: "forecast-app.html",
      mimeType: "text/html",
    });
    const [app] = await db
      .insert(apps)
      .values({
        slug: `forecast-${randomUUID()}`,
        name: "Forecast",
        ownerUserId: alice.id,
        sourceThreadId: threadId,
      })
      .returning();
    const [version] = await db
      .insert(appVersions)
      .values({
        appId: app!.id,
        artifactId: artifact.id,
        versionNumber: 1,
        status: "proposed",
        createdByUserId: alice.id,
        sourceThreadId: threadId,
      })
      .returning();

    const { snapshot } = await createThreadBranch({
      db,
      actor: alice,
      request: {
        sourceType: "app_version",
        sourceThreadId: threadId,
        artifactId: artifact.id,
        appVersionId: version!.id,
      },
    });

    expect(snapshot.primaryAppVersionIdSnapshot).toBe(version!.id);
    expect(snapshot.resources).toEqual([
      expect.objectContaining({
        artifactIdSnapshot: artifact.id,
        appVersionIdSnapshot: version!.id,
        appVersionStatus: "proposed",
      }),
    ]);
  });

  async function seedSimpleThread() {
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: alice.id,
        title: "Source work",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    const message = await insertMessage(
      thread!.id,
      "assistant",
      "Created the source file",
      0,
    );
    return { threadId: thread!.id, messageId: message.id };
  }

  async function insertMessage(
    threadId: string,
    role: "user" | "assistant" | "tool",
    content: string,
    offsetSeconds: number,
    extra: { toolCalls?: unknown; toolResults?: unknown } = {},
  ) {
    const [message] = await db
      .insert(chatMessages)
      .values({
        threadId,
        role,
        content,
        toolCalls: extra.toolCalls,
        toolResults: extra.toolResults,
        createdAt: new Date(Date.UTC(2026, 7, 11, 12, 0, offsetSeconds)),
      })
      .returning();
    return message!;
  }

  async function insertArtifact({
    userId,
    threadId,
    messageId,
    filename,
    source = "assistant",
    mimeType = "text/markdown",
    content = "# Artifact",
    metadata,
  }: {
    userId: string;
    threadId: string;
    messageId: string;
    filename: string;
    source?: string;
    mimeType?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }) {
    const [artifact] = await db
      .insert(workspaceArtifacts)
      .values({
        userId,
        threadId,
        chatMessageId: messageId,
        title: filename,
        filename,
        artifactGroupId: randomUUID(),
        versionNumber: 1,
        kind: mimeType === "text/html" ? "html" : "document",
        mimeType,
        content,
        sizeBytes: Buffer.byteLength(content),
        source,
        metadata,
      })
      .returning();
    return artifact!;
  }
});

function asSession(row: typeof users.$inferSelect): SessionUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
  } as SessionUser;
}
