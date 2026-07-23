import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";
import {
  appEditSessions,
  appVersions,
  apps,
  auditLog,
  chatMessages,
  chatThreads,
  createDb,
  runs,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import type { ChatStreamEvent } from "@/lib/chat-stream-contract";
import {
  outputProposalFromMetadata,
  withOutputProposal,
} from "@/lib/output-proposals";
import {
  completeProposalIteration,
  outputProposalContextForIteration,
  proposalIterationFromRunInputs,
  releaseProposalIteration,
} from "@/lib/proposal-iterations";
import { readChatSseStream } from "@/lib/sse";
import { serializeWorkspaceArtifact } from "@/lib/workspace-artifacts";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "proposal iteration integration suite: DATABASE_URL is empty in CI; refusing to green-by-skip.",
  );
}

let currentUser: SessionUser | null = null;
vi.mock("@/lib/auth/getSessionUser", () => ({
  getSessionUser: async () => currentUser,
}));
vi.mock("@/lib/model-registry", () => ({
  isModelEnabled: vi.fn(async () => true),
  resolveModelForPurpose: vi.fn(async () => "sonnet-4-6"),
}));
vi.mock("@/lib/chat-run-worker", () => ({
  startInProcessChatRunWorker: vi.fn(),
}));

const suite = describe.skipIf(!DB_URL);

suite("proposal iteration lifecycle (real route, real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 6 });
  let alice: SessionUser;
  let bob: SessionUser;
  let threadId: string;

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    await db.delete(users);
    const [aliceRow, bobRow] = await db
      .insert(users)
      .values([
        {
          pingSubject: `proposal-alice-${randomUUID()}`,
          email: `proposal-alice-${randomUUID()}@example.com`,
          displayName: "Alice",
          role: "user",
        },
        {
          pingSubject: `proposal-bob-${randomUUID()}`,
          email: `proposal-bob-${randomUUID()}@example.com`,
          displayName: "Bob",
          role: "user",
        },
      ])
      .returning();
    const toSession = (row: typeof aliceRow): SessionUser =>
      ({
        id: row!.id,
        email: row!.email,
        displayName: row!.displayName,
        role: row!.role,
      }) as SessionUser;
    alice = toSession(aliceRow);
    bob = toSession(bobRow);
    currentUser = alice;
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: alice.id,
        title: "Proposal iteration",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    threadId = thread!.id;
  });

  afterAll(async () => {
    await db.delete(users);
  });

  async function seedProposal({
    filename,
    mimeType,
  }: {
    filename: string;
    mimeType: string;
  }) {
    const [sourceRun] = await db
      .insert(runs)
      .values({
        userId: alice.id,
        threadId,
        triggerType: "scheduled",
        status: "succeeded",
        modelId: "sonnet-4-6",
      })
      .returning();
    const [message] = await db
      .insert(chatMessages)
      .values({
        threadId,
        role: "assistant",
        content: "A proposed update is ready.",
      })
      .returning();
    const artifactGroupId = randomUUID();
    const [artifact] = await db
      .insert(workspaceArtifacts)
      .values({
        userId: alice.id,
        threadId,
        chatMessageId: message!.id,
        runId: sourceRun!.id,
        title: filename,
        filename,
        artifactGroupId,
        versionNumber: 1,
        kind: mimeType === "text/html" ? "file" : "document",
        mimeType,
        content: mimeType === "text/html" ? "<html>v1</html>" : "# v1",
        sizeBytes: 16,
        source: "assistant",
        metadata: withOutputProposal(
          {},
          {
            runId: sourceRun!.id,
            triggerType: "scheduled",
            createdAt: new Date("2026-07-23T12:00:00.000Z").toISOString(),
          },
        ),
      })
      .returning();
    return { artifact: artifact!, sourceRun: sourceRun! };
  }

  async function postIteration(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/output-proposals/iterate/route");
    return POST(
      new Request("http://test.local/api/output-proposals/iterate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function collectSse(response: Response) {
    const events: ChatStreamEvent[] = [];
    for await (const event of readChatSseStream(response)) events.push(event);
    return events;
  }

  it("reserves one artifact iteration winner and hides the proposal from other users", async () => {
    const { artifact } = await seedProposal({
      filename: "weekly-report.md",
      mimeType: "text/markdown",
    });

    currentUser = bob;
    const denied = await postIteration({
      threadId,
      modelId: "sonnet-4-6",
      proposalIteration: {
        target: { kind: "artifact", artifactId: artifact.id },
        feedback: "Try to take over this proposal.",
      },
    });
    expect(denied.status).toBe(404);

    currentUser = alice;
    const response = await postIteration({
      threadId,
      modelId: "sonnet-4-6",
      proposalIteration: {
        target: { kind: "artifact", artifactId: artifact.id },
        feedback: "  Add   a concise risks section. ",
      },
    });
    expect(response.status).toBe(200);
    const events = await collectSse(response);
    expect(events.map((event) => event.type)).toEqual([
      "meta",
      "queued",
      "done",
    ]);
    const meta = events[0] as Extract<ChatStreamEvent, { type: "meta" }>;

    const [storedArtifact] = await db
      .select()
      .from(workspaceArtifacts)
      .where(eq(workspaceArtifacts.id, artifact.id));
    expect(outputProposalFromMetadata(storedArtifact?.metadata)).toMatchObject({
      status: "iterating",
      iteration: {
        runId: meta.runId,
        feedbackMessageId: meta.userMessageId,
        requestedByUserId: alice.id,
      },
    });
    const [storedRun] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, meta.runId as string));
    expect(storedRun).toMatchObject({
      status: "queued",
      triggerType: "proposal_iteration",
      threadId,
      userId: alice.id,
    });
    expect(proposalIterationFromRunInputs(storedRun?.inputs)).toMatchObject({
      sourceArtifactId: artifact.id,
      sourceThreadId: threadId,
      feedbackMessageId: meta.userMessageId,
    });
    const [feedbackMessage] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, meta.userMessageId as string));
    expect(feedbackMessage?.content).toBe(
      "Iterate on weekly-report.md: Add a concise risks section.",
    );
    const requestAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.runId, meta.runId as string),
          eq(auditLog.actionType, "proposal_iteration_requested"),
        ),
      );
    expect(requestAudits).toHaveLength(1);
    expect(requestAudits[0]?.input).toMatchObject({
      sourceArtifactId: artifact.id,
      feedback: "Add a concise risks section.",
    });

    const loser = await postIteration({
      threadId,
      proposalIteration: {
        target: { kind: "artifact", artifactId: artifact.id },
        feedback: "A competing update.",
      },
    });
    expect(loser.status).toBe(409);
  });

  it("restores a failed app iteration, then preserves lineage when a retry succeeds", async () => {
    const { artifact } = await seedProposal({
      filename: "revenue-dashboard.html",
      mimeType: "text/html",
    });
    const [app] = await db
      .insert(apps)
      .values({
        slug: `proposal-app-${randomUUID()}`,
        name: "Revenue Dashboard",
        ownerUserId: alice.id,
        sourceThreadId: threadId,
      })
      .returning();
    const [sourceVersion] = await db
      .insert(appVersions)
      .values({
        appId: app!.id,
        artifactId: artifact.id,
        versionNumber: 1,
        status: "proposed",
        summary: "Initial proposal",
        createdByUserId: alice.id,
        sourceThreadId: threadId,
      })
      .returning();
    await db.insert(appEditSessions).values({
      appId: app!.id,
      threadId,
      baseVersionId: sourceVersion!.id,
      status: "active",
      createdByUserId: alice.id,
    });

    const reserve = async (feedback: string) => {
      const response = await postIteration({
        threadId,
        modelId: "sonnet-4-6",
        proposalIteration: {
          target: {
            kind: "app",
            appId: app!.id,
            appVersionId: sourceVersion!.id,
          },
          feedback,
        },
      });
      expect(response.status).toBe(200);
      const events = await collectSse(response);
      const meta = events[0] as Extract<ChatStreamEvent, { type: "meta" }>;
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, meta.runId as string));
      const iteration = proposalIterationFromRunInputs(run?.inputs);
      expect(iteration).not.toBeNull();
      return { run: run!, iteration: iteration! };
    };

    const first = await reserve("Use a more compact chart.");
    expect(
      await releaseProposalIteration({
        db,
        iteration: first.iteration,
        error: "Provider unavailable.",
      }),
    ).toBe(true);
    await db
      .update(runs)
      .set({ status: "failed", error: "Provider unavailable." })
      .where(eq(runs.id, first.run.id));
    const [restoredArtifact] = await db
      .select()
      .from(workspaceArtifacts)
      .where(eq(workspaceArtifacts.id, artifact.id));
    const [restoredVersion] = await db
      .select()
      .from(appVersions)
      .where(eq(appVersions.id, sourceVersion!.id));
    expect(outputProposalFromMetadata(restoredArtifact?.metadata)?.status).toBe(
      "proposed",
    );
    expect(restoredVersion?.status).toBe("proposed");

    const second = await reserve("Use a compact chart and stronger labels.");
    const [replacementMessage] = await db
      .insert(chatMessages)
      .values({
        threadId,
        role: "assistant",
        content: "The replacement is ready.",
      })
      .returning();
    const [replacementArtifact] = await db
      .insert(workspaceArtifacts)
      .values({
        userId: alice.id,
        threadId,
        chatMessageId: replacementMessage!.id,
        runId: second.run.id,
        title: artifact.title,
        filename: artifact.filename,
        artifactGroupId: artifact.artifactGroupId,
        versionNumber: 2,
        supersedesArtifactId: artifact.id,
        versionSummary: "Used compact chart labels.",
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        content: "<html>v2</html>",
        sizeBytes: 16,
        source: "assistant",
        metadata: withOutputProposal(
          {},
          outputProposalContextForIteration(second.iteration, new Date()),
        ),
      })
      .returning();
    const [replacementVersion] = await db
      .insert(appVersions)
      .values({
        appId: app!.id,
        artifactId: replacementArtifact!.id,
        versionNumber: 2,
        status: "proposed",
        summary: "Used compact chart labels.",
        createdByUserId: alice.id,
        sourceThreadId: threadId,
      })
      .returning();

    expect(
      await completeProposalIteration({
        db,
        iteration: second.iteration,
        replacementArtifact: serializeWorkspaceArtifact(replacementArtifact!),
        replacementAppVersion: {
          id: replacementVersion!.id,
          appId: app!.id,
          appName: app!.name,
          appSlug: app!.slug,
          artifactId: replacementArtifact!.id,
          versionNumber: replacementVersion!.versionNumber,
          status: "proposed",
          canDeploy: true,
          previewUrl: `/api/apps/${app!.id}/versions/${replacementVersion!.id}/content`,
          liveUrl: `/apps/${app!.slug}`,
        },
      }),
    ).toBe(true);

    const [supersededArtifact] = await db
      .select()
      .from(workspaceArtifacts)
      .where(eq(workspaceArtifacts.id, artifact.id));
    const [supersededVersion] = await db
      .select()
      .from(appVersions)
      .where(eq(appVersions.id, sourceVersion!.id));
    const [pendingReplacementVersion] = await db
      .select()
      .from(appVersions)
      .where(eq(appVersions.id, replacementVersion!.id));
    expect(
      outputProposalFromMetadata(supersededArtifact?.metadata),
    ).toMatchObject({
      status: "superseded",
      replacedByArtifactId: replacementArtifact!.id,
    });
    expect(supersededVersion?.status).toBe("superseded");
    expect(pendingReplacementVersion?.status).toBe("proposed");
    expect(
      outputProposalFromMetadata(replacementArtifact?.metadata),
    ).toMatchObject({
      status: "proposed",
      iterationOf: {
        sourceArtifactId: artifact.id,
        sourceAppVersionId: sourceVersion!.id,
      },
    });
  });
});
