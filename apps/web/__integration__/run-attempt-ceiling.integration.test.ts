import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  chatThreads,
  createDb,
  runs,
  users,
} from "@ai-workspace/db";
import {
  claimChatRun,
  quarantineExhaustedRuns,
} from "@/lib/chat-run-worker";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "attempt ceiling suite: DATABASE_URL is empty in CI; refusing to green-by-skip.",
  );
}

const suite = describe.skipIf(!DB_URL);

/**
 * #464: the claim condition and the quarantine sweep are SQL predicates, so
 * the only honest test of "a poison pill stops being reclaimed" runs them
 * against real Postgres rows. Without the ceiling every case below reclaims.
 */
suite("run attempt ceiling (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 4 });
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
        pingSubject: "attempt-ceiling-user",
        email: "attempt-ceiling@example.com",
        displayName: "Attempt Ceiling",
        role: "user",
      })
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: user!.id,
        title: "Attempt ceiling",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    userId = user!.id;
    threadId = thread!.id;
  });

  afterAll(async () => {
    await db.delete(users);
  });

  function insertRun(overrides: Partial<typeof runs.$inferInsert> = {}) {
    return db
      .insert(runs)
      .values({
        userId,
        threadId,
        skillSlug: "chat-turn",
        triggerType: "chat",
        status: "queued",
        inputs: {
          prompt: "poison",
          threadId,
          userMessageId: "user-msg-1",
          executionMode: "local",
        },
        ...overrides,
      })
      .returning();
  }

  const load = async (runId: string) =>
    (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;

  const expired = () => new Date(Date.now() - 60_000);

  it("reclaims a lapsed run that is still below the ceiling", async () => {
    const [run] = await insertRun({
      status: "running",
      workerId: "dead-worker",
      leaseExpiresAt: expired(),
      attemptCount: 2,
    });

    const claimed = await claimChatRun({ db, workerId: "w-live" });

    expect(claimed?.id).toBe(run!.id);
    const row = await load(run!.id);
    expect(row.attemptCount).toBe(3);
    expect(row.workerId).toBe("w-live");
    expect(row.status).toBe("running");
  });

  it("stops reclaiming a run that has reached the ceiling", async () => {
    const [run] = await insertRun({
      status: "running",
      workerId: "dead-worker",
      leaseExpiresAt: expired(),
      attemptCount: 3,
    });

    // Both the scan path and the targeted path must refuse it.
    expect(await claimChatRun({ db, workerId: "w-live" })).toBeNull();
    expect(
      await claimChatRun({ db, runId: run!.id, workerId: "w-live" }),
    ).toBeNull();
    const row = await load(run!.id);
    expect(row.attemptCount).toBe(3);
    expect(row.workerId).toBe("dead-worker");
  });

  it("does not let an exhausted run block healthy work behind it", async () => {
    const [poison] = await insertRun({
      status: "running",
      workerId: "dead-worker",
      leaseExpiresAt: expired(),
      attemptCount: 3,
    });
    // Queued after the poison pill, so the oldest-first scan reaches the
    // poison pill first and used to hand it out on every lease expiry.
    const [healthy] = await insertRun();

    const claimed = await claimChatRun({ db, workerId: "w-live" });

    expect(claimed?.id).toBe(healthy!.id);
    expect((await load(poison!.id)).status).toBe("running");
  });

  it("quarantines the exhausted run as failed and frees its lane slot", async () => {
    const [run] = await insertRun({
      status: "running",
      workerId: "dead-worker",
      leaseExpiresAt: expired(),
      attemptCount: 3,
    });

    expect(await quarantineExhaustedRuns({ db })).toBe(1);

    const row = await load(run!.id);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("3-attempt ceiling");
    expect(row.workerId).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.completedAt).not.toBeNull();
    // Terminal, so nothing re-enters the lane on the next sweep.
    expect(await quarantineExhaustedRuns({ db })).toBe(0);
    expect(await claimChatRun({ db, workerId: "w-live" })).toBeNull();
  });

  it("never quarantines a run executing under a live lease", async () => {
    const [live] = await insertRun({
      status: "running",
      workerId: "w-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      attemptCount: 9,
    });

    expect(await quarantineExhaustedRuns({ db })).toBe(0);

    const row = await load(live!.id);
    expect(row.status).toBe("running");
    expect(row.workerId).toBe("w-owner");
  });

  it("honours a tuned ceiling", async () => {
    const [run] = await insertRun({ attemptCount: 1 });

    expect(await quarantineExhaustedRuns({ db, maxAttempts: 1 })).toBe(1);
    expect((await load(run!.id)).error).toContain("1-attempt ceiling");
  });
});
