import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  and,
  asc,
  count,
  eq,
  inArray,
} from "drizzle-orm";
import {
  auditLog,
  chatMessages,
  chatThreads,
  createDb,
  runs,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { persistAssistantMessageOnce } from "@/lib/assistant-message-persistence";
import { createArtifactsFromAssistantMessage } from "@/lib/workspace-artifacts";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "concurrent persistence suite: DATABASE_URL is empty in CI; refusing to green-by-skip.",
  );
}

const suite = describe.skipIf(!DB_URL);

suite("concurrent chat persistence (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 12 });
  let userId: string;
  let threadId: string;

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    await db.delete(users);
    const [user] = await db
      .insert(users)
      .values({
        pingSubject: "concurrent-persistence-user",
        email: "concurrent-persistence@example.com",
        displayName: "Concurrency",
        role: "user",
      })
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: user!.id,
        title: "Concurrent persistence",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    userId = user!.id;
    threadId = thread!.id;
  });

  afterAll(async () => {
    await db.delete(users);
  });

  it("converges concurrent assistant completion attempts on one message and audit", async () => {
    const [run] = await db
      .insert(runs)
      .values({
        userId,
        threadId,
        triggerType: "chat",
        status: "running",
        workerId: "worker-current",
        outputs: { lifecycle: "provider_started" },
      })
      .returning();
    const input = {
      db,
      runId: run!.id,
      userId,
      threadId,
      lane: "worker" as const,
      expectedWorkerId: "worker-current",
      content: "One durable answer.",
      modelId: "sonnet-4-6",
      runtime: "bedrock",
      tokensIn: 12,
      tokensOut: 4,
      toolCalls: [],
      toolResults: [],
    };

    const results = await Promise.all([
      persistAssistantMessageOnce(input),
      persistAssistantMessageOnce(input),
      persistAssistantMessageOnce(input),
    ]);

    expect(new Set(results.map((result) => result?.assistantMessageId)).size).toBe(1);
    expect(results.filter((result) => result?.created)).toHaveLength(1);

    const [messageCount] = await db
      .select({ value: count() })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "assistant"),
        ),
      );
    expect(messageCount?.value).toBe(1);

    const [auditCount] = await db
      .select({ value: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.runId, run!.id),
          eq(auditLog.actionType, "chat_message_create"),
        ),
      );
    expect(auditCount?.value).toBe(1);

    const [storedRun] = await db
      .select({ outputs: runs.outputs })
      .from(runs)
      .where(eq(runs.id, run!.id));
    expect(storedRun?.outputs).toMatchObject({
      lifecycle: "provider_started",
      assistantMessageId: results[0]!.assistantMessageId,
    });
  });

  it("refuses persistence after a worker loses lease ownership", async () => {
    const [run] = await db
      .insert(runs)
      .values({
        userId,
        threadId,
        triggerType: "chat",
        status: "running",
        workerId: "worker-new",
      })
      .returning();

    const result = await persistAssistantMessageOnce({
      db,
      runId: run!.id,
      userId,
      threadId,
      lane: "worker",
      expectedWorkerId: "worker-stale",
      content: "This must not persist.",
      modelId: "sonnet-4-6",
      runtime: "bedrock",
      tokensIn: 1,
      tokensOut: 1,
      toolCalls: [],
      toolResults: [],
    });

    expect(result).toBeNull();
    const rows = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId));
    expect(rows).toHaveLength(0);
  });

  it("allocates every artifact revision under concurrent mints without dropping a batch", async () => {
    const messages = await db
      .insert(chatMessages)
      .values(
        Array.from({ length: 7 }, (_, index) => ({
          threadId,
          role: "assistant" as const,
          content: `artifact response ${index + 1}`,
        })),
      )
      .returning({ id: chatMessages.id });
    const artifactText = (label: string) =>
      '```html filename="report.html"\n' +
      `<html><body><h1>${label}</h1>${"x".repeat(300)}</body></html>\n` +
      "```";

    const first = await createArtifactsFromAssistantMessage({
      db,
      userId,
      threadId,
      chatMessageId: messages[0]!.id,
      assistantText: artifactText("base"),
    });
    expect(first).toHaveLength(1);

    const created = await Promise.all(
      messages.slice(1).map((message, index) =>
        createArtifactsFromAssistantMessage({
          db,
          userId,
          threadId,
          chatMessageId: message.id,
          assistantText: artifactText(`revision-${index + 1}`),
        }),
      ),
    );

    expect(created.every((batch) => batch.length === 1)).toBe(true);
    const allIds = created.flat().map((artifact) => artifact.id);
    expect(new Set(allIds).size).toBe(6);

    const rows = await db
      .select({
        id: workspaceArtifacts.id,
        artifactGroupId: workspaceArtifacts.artifactGroupId,
        versionNumber: workspaceArtifacts.versionNumber,
      })
      .from(workspaceArtifacts)
      .where(
        and(
          eq(workspaceArtifacts.userId, userId),
          inArray(workspaceArtifacts.chatMessageId, messages.map((message) => message.id)),
        ),
      )
      .orderBy(asc(workspaceArtifacts.versionNumber));
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.artifactGroupId)).size).toBe(1);
    expect(rows.map((row) => row.versionNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
