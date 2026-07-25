import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import type { SessionUser } from "@ai-workspace/auth";
import {
  chatMessages,
  chatThreads,
  createDb,
  type Database,
  runs,
  users,
} from "@ai-workspace/db";
import { persistAssistantMessageOnce } from "@/lib/assistant-message-persistence";
import { cancelRun } from "@/lib/run-actions";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "cancel race suite: DATABASE_URL is empty in CI; refusing to green-by-skip.",
  );
}

const suite = describe.skipIf(!DB_URL);

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * #655: a user cancel must serialize against the FOR UPDATE transaction that
 * commits the durable assistant answer. These tests run the two writers
 * against real Postgres row locks — the boundary the original TOCTOU bug
 * lived on.
 */
suite("run cancellation vs durable results (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 12 });
  let userId: string;
  let threadId: string;
  let actor: SessionUser;

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    await db.delete(users);
    const [user] = await db
      .insert(users)
      .values({
        pingSubject: "cancel-race-user",
        email: "cancel-race@example.com",
        displayName: "Cancel Race",
        role: "user",
      })
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: user!.id,
        title: "Cancel race",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    userId = user!.id;
    threadId = thread!.id;
    actor = {
      id: userId,
      email: "cancel-race@example.com",
      displayName: "Cancel Race",
      role: "user",
    } as SessionUser;
  });

  afterAll(async () => {
    await db.delete(users);
  });

  function insertChatRun(
    overrides: Partial<typeof runs.$inferInsert> = {},
  ) {
    return db
      .insert(runs)
      .values({
        userId,
        threadId,
        skillSlug: "chat-turn",
        triggerType: "chat",
        status: "running",
        ...overrides,
      })
      .returning();
  }

  it("returns result_committed when cancel races the committing durable answer", async () => {
    const [run] = await insertChatRun({
      workerId: "worker-a",
      outputs: { lifecycle: "provider_started" },
    });

    let releaseTx!: () => void;
    const holdTx = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    let signalPersisted!: (assistantMessageId: string) => void;
    const persistedInTx = new Promise<string>((resolve) => {
      signalPersisted = resolve;
    });

    // Transaction A: the real persistence path (savepoint inside), held open
    // so its FOR UPDATE lock on the run row is still live when cancel lands.
    const txPromise = db.transaction(async (tx) => {
      const persisted = await persistAssistantMessageOnce({
        db: tx as unknown as Database,
        runId: run!.id,
        userId,
        threadId,
        lane: "worker",
        expectedWorkerId: "worker-a",
        content: "Durable answer.",
        modelId: "sonnet-4-6",
        runtime: "bedrock",
        tokensIn: 10,
        tokensOut: 5,
        toolCalls: [],
        toolResults: [],
      });
      signalPersisted(persisted!.assistantMessageId);
      await holdTx;
    });

    const assistantMessageId = await persistedInTx;
    const cancelPromise = cancelRun({ db, actor, runId: run!.id });
    // Deterministic interleave: the cancel must be blocked on the row lock,
    // not racing ahead of the commit.
    const early = await Promise.race([
      cancelPromise.then(() => "resolved" as const),
      sleep(300).then(() => "blocked" as const),
    ]);
    expect(early).toBe("blocked");
    releaseTx();
    await txPromise;

    const result = await cancelPromise;
    expect(result).toMatchObject({ ok: true, outcome: "result_committed" });

    // The worker's fenced terminal write (execute-chat-turn) still lands
    // because the cancel kept its hands off the row.
    const completedAt = new Date();
    const terminalRows = await db
      .update(runs)
      .set({
        status: "succeeded",
        error: null,
        workerId: null,
        leaseExpiresAt: null,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(runs.id, run!.id),
          ne(runs.status, "canceled"),
          eq(runs.workerId, "worker-a"),
        ),
      )
      .returning({ id: runs.id });
    expect(terminalRows).toHaveLength(1);

    const [stored] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, run!.id));
    expect(stored?.status).toBe("succeeded");
    expect(stored?.outputs).toMatchObject({ assistantMessageId });

    const messages = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "assistant"),
        ),
      );
    expect(messages).toHaveLength(1);
  });

  it("cancels a queued run before any durable answer exists", async () => {
    const [run] = await insertChatRun({ status: "queued" });

    const result = await cancelRun({ db, actor, runId: run!.id });

    expect(result).toMatchObject({
      ok: true,
      outcome: "canceled",
      run: { id: run!.id, status: "canceled" },
    });
    const [stored] = await db
      .select({ status: runs.status, error: runs.error })
      .from(runs)
      .where(eq(runs.id, run!.id));
    expect(stored).toEqual({ status: "canceled", error: "Canceled by user." });
  });

  it("reports already_canceled on a repeated cancel without rewriting the row", async () => {
    const [run] = await insertChatRun({ status: "queued" });
    await cancelRun({ db, actor, runId: run!.id });
    const [afterFirst] = await db
      .select({ completedAt: runs.completedAt })
      .from(runs)
      .where(eq(runs.id, run!.id));

    const result = await cancelRun({ db, actor, runId: run!.id });

    expect(result).toMatchObject({
      ok: true,
      outcome: "already_canceled",
      run: { id: run!.id, status: "canceled" },
    });
    const [afterSecond] = await db
      .select({ completedAt: runs.completedAt })
      .from(runs)
      .where(eq(runs.id, run!.id));
    expect(afterSecond?.completedAt?.getTime()).toBe(
      afterFirst?.completedAt?.getTime(),
    );
  });

  it("reports already_terminal on a succeeded run and leaves it untouched", async () => {
    const completedAt = new Date("2026-07-20T12:00:00.000Z");
    const [run] = await insertChatRun({
      status: "succeeded",
      outputs: { assistantMessageId: "assistant-durable" },
      completedAt,
    });

    const result = await cancelRun({ db, actor, runId: run!.id });

    expect(result).toMatchObject({
      ok: true,
      outcome: "already_terminal",
      run: { id: run!.id, status: "succeeded" },
    });
    const [stored] = await db
      .select({
        status: runs.status,
        error: runs.error,
        completedAt: runs.completedAt,
        outputs: runs.outputs,
      })
      .from(runs)
      .where(eq(runs.id, run!.id));
    expect(stored?.status).toBe("succeeded");
    expect(stored?.error).toBeNull();
    expect(stored?.completedAt?.getTime()).toBe(completedAt.getTime());
    expect(stored?.outputs).toMatchObject({
      assistantMessageId: "assistant-durable",
    });
  });

  it("persistAssistantMessageOnce still refuses an already-canceled run", async () => {
    const [run] = await insertChatRun({ status: "running" });
    await cancelRun({ db, actor, runId: run!.id });

    const result = await persistAssistantMessageOnce({
      db,
      runId: run!.id,
      userId,
      threadId,
      lane: "worker",
      content: "This must not persist.",
      modelId: "sonnet-4-6",
      runtime: "bedrock",
      tokensIn: 1,
      tokensOut: 1,
      toolCalls: [],
      toolResults: [],
    });

    expect(result).toBeNull();
    const messages = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId));
    expect(messages).toHaveLength(0);
  });
});
