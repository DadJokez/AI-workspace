import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  chatThreads,
  createDb,
  eventTriggers,
  oauthTokens,
  runs,
  schedules,
  skills,
  users,
} from "@ai-workspace/db";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * WP-18 against real Postgres, through the real `getSessionUser`: only
 * next-auth's cookie decoding is replaced, so each test chooses the decoded
 * session (user id and the `sv` stamped at sign-in) and everything after it
 * (the row read, the status and version check, the conditional last-seen
 * write, the lifecycle transaction, the worker and scheduler claims) is the
 * production code.
 */

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL && process.env.CI) {
  throw new Error(
    "user lifecycle suite: DATABASE_URL is empty in CI; refusing to green-by-skip.",
  );
}

process.env.OAUTH_ENCRYPTION_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/** What next-auth would have decoded from the request's session cookie. */
let decodedSession: { user: { id: string; sessionVersion?: number } } | null =
  null;
vi.mock("next-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-auth")>()),
  getServerSession: async () => decodedSession,
}));

const suite = describe.skipIf(!DB_URL);

suite("user lifecycle (real Postgres)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 4 });

  let alice: SessionUser;
  let admin: SessionUser;
  let secondAdmin: SessionUser;
  let aliceThreadId: string;

  const signedInAs = (user: SessionUser, sessionVersion = 0) => {
    decodedSession = { user: { id: user.id, sessionVersion } };
  };

  async function changeStatus(
    actor: SessionUser,
    target: SessionUser,
    action: "suspend" | "deprovision" | "reactivate",
    reason = "Access review",
  ) {
    signedInAs(actor);
    const { POST } = await import("@/app/api/admin/users/[id]/status/route");
    return POST(
      new Request(`http://test.local/api/admin/users/${target.id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason }),
      }),
      { params: Promise.resolve({ id: target.id }) },
    );
  }

  async function listThreads() {
    const { GET } = await import("@/app/api/threads/route");
    return GET(new Request("http://test.local/api/threads"));
  }

  async function userRow(id: string) {
    const rows = await db.select().from(users).where(eq(users.id, id));
    return rows[0]!;
  }

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    decodedSession = null;
    await db.delete(users);
    const [a, adm, adm2] = await db
      .insert(users)
      .values([
        {
          pingSubject: "lifecycle-alice",
          email: "lifecycle-alice@example.com",
          displayName: "Alice",
          role: "user",
        },
        {
          pingSubject: "lifecycle-admin",
          email: "lifecycle-admin@example.com",
          displayName: "Admin",
          role: "admin",
        },
        {
          pingSubject: "lifecycle-admin-2",
          email: "lifecycle-admin-2@example.com",
          displayName: "Second Admin",
          role: "admin",
        },
      ])
      .returning();
    const asSession = (u: typeof a): SessionUser => ({
      id: u!.id,
      email: u!.email,
      displayName: u!.displayName,
      role: u!.role,
    });
    alice = asSession(a);
    admin = asSession(adm);
    secondAdmin = asSession(adm2);
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: alice.id,
        title: "Alice's thread",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    aliceThreadId = thread!.id;
  });

  afterAll(async () => {
    await db.delete(users);
  });

  it("refuses a suspended user's request while their JWT is still valid, and keeps refusing it after reactivation", async () => {
    signedInAs(alice);
    expect((await listThreads()).status).toBe(200);

    const suspended = await changeStatus(admin, alice, "suspend");
    expect(suspended.status).toBe(200);

    // The same token, unexpired and correctly signed: refused.
    signedInAs(alice, 0);
    expect((await listThreads()).status).toBe(401);

    expect((await changeStatus(admin, alice, "reactivate")).status).toBe(200);
    // Reactivation restores sign-in, not the old token.
    signedInAs(alice, 0);
    expect((await listThreads()).status).toBe(401);
    // A fresh sign-in stamps the bumped version.
    signedInAs(alice, (await userRow(alice.id)).sessionVersion);
    expect((await listThreads()).status).toBe(200);
  });

  it("writes last_seen_at at most once per five-minute window", async () => {
    const { getSessionUser } = await import("@/lib/auth/getSessionUser");
    await db
      .update(users)
      .set({ lastSeenAt: sql`now() - interval '10 minutes'` })
      .where(eq(users.id, alice.id));
    const stale = (await userRow(alice.id)).lastSeenAt;

    signedInAs(alice);
    await getSessionUser();
    const touched = (await userRow(alice.id)).lastSeenAt;
    expect(touched.getTime()).toBeGreaterThan(stale.getTime());

    await getSessionUser();
    await getSessionUser();
    expect((await userRow(alice.id)).lastSeenAt).toEqual(touched);

    // Four minutes old is still inside the window.
    await db
      .update(users)
      .set({ lastSeenAt: sql`now() - interval '4 minutes'` })
      .where(eq(users.id, alice.id));
    const recent = (await userRow(alice.id)).lastSeenAt;
    await getSessionUser();
    expect((await userRow(alice.id)).lastSeenAt).toEqual(recent);
  });

  it("suspension revokes connections, turns off schedules and triggers, cancels live runs, and deletes nothing", async () => {
    const { storeOAuthConnection } = await import("@/lib/oauth/connection");
    await storeOAuthConnection({
      db,
      userId: alice.id,
      provider: "github",
      accessToken: "alice-access-token",
      attestationReason: "test",
      attestationSource: "test",
    });
    const [skill] = await db
      .insert(skills)
      .values({
        slug: "lifecycle-brief",
        name: "Brief",
        ownerUserId: alice.id,
        systemPrompt: "Summarize.",
        modelId: "sonnet-4-6",
        mcpProviders: [],
        isStarter: false,
      })
      .returning();
    const [schedule] = await db
      .insert(schedules)
      .values({
        userId: alice.id,
        skillId: skill!.id,
        cadence: "0 8 * * *",
        timezone: "UTC",
        nextRunAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const [trigger] = await db
      .insert(eventTriggers)
      .values({
        userId: alice.id,
        skillId: skill!.id,
        repository: "acme/app",
        eventType: "pull_request",
      })
      .returning();
    const chatInputs = {
      prompt: "hello",
      threadId: aliceThreadId,
      userMessageId: "msg-1",
      executionMode: "local",
    };
    const [queued, running, finished] = await db
      .insert(runs)
      .values([
        { userId: alice.id, threadId: aliceThreadId, skillSlug: "chat-turn", triggerType: "chat", status: "queued", inputs: chatInputs },
        { userId: alice.id, threadId: aliceThreadId, skillSlug: "chat-turn", triggerType: "chat", status: "running", inputs: chatInputs },
        { userId: alice.id, threadId: aliceThreadId, skillSlug: "chat-turn", triggerType: "chat", status: "succeeded", inputs: chatInputs },
      ])
      .returning();

    const res = await changeStatus(admin, alice, "suspend", "Left the team");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effects: Record<string, unknown> };
    expect(body.effects).toEqual({
      sessionVersion: 1,
      revokedConnections: ["github"],
      disabledScheduleIds: [schedule!.id],
      disabledEventTriggerIds: [trigger!.id],
      canceledRunIds: expect.arrayContaining([queued!.id, running!.id]),
      uncanceledRunIds: [],
    });

    expect(await userRow(alice.id)).toMatchObject({
      status: "suspended",
      sessionVersion: 1,
      statusReason: "Left the team",
      statusChangedAt: expect.any(Date),
    });
    const [token] = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, alice.id));
    expect(token).toMatchObject({ revokedBy: admin.id, refreshToken: null });
    expect(token!.revokedAt).toBeInstanceOf(Date);
    expect(token!.accessToken).not.toContain("alice-access-token");
    expect(
      (await db.select().from(schedules).where(eq(schedules.id, schedule!.id)))[0]!
        .enabled,
    ).toBe(false);
    expect(
      (await db.select().from(eventTriggers).where(eq(eventTriggers.id, trigger!.id)))[0]!
        .enabled,
    ).toBe(false);
    const runStatuses = await db
      .select({ id: runs.id, status: runs.status, error: runs.error })
      .from(runs)
      .where(inArray(runs.id, [queued!.id, running!.id, finished!.id]));
    expect(Object.fromEntries(runStatuses.map((r) => [r.id, r.status]))).toEqual({
      [queued!.id]: "canceled",
      [running!.id]: "canceled",
      [finished!.id]: "succeeded",
    });
    expect(
      runStatuses.find((r) => r.id === queued!.id)!.error,
    ).toBe("Canceled: the account was suspended.");
    // Nothing deleted.
    expect(
      await db.select().from(chatThreads).where(eq(chatThreads.userId, alice.id)),
    ).toHaveLength(1);

    const actions = await db
      .select({ actionType: auditLog.actionType, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, admin.id));
    expect(actions.map((a) => a.actionType).sort()).toEqual([
      // The connection's grant goes with it (revokeOAuthConnection).
      "attestation.revoked",
      "connection.revoked",
      "run_cancel",
      "run_cancel",
      "user.suspended",
    ]);
    expect(
      actions.find((a) => a.actionType === "user.suspended")!.metadata,
    ).toMatchObject({
      previousStatus: "active",
      newStatus: "suspended",
      reason: "Left the team",
    });
    expect(JSON.stringify(actions)).not.toContain("alice-access-token");

    // Reactivation leaves every withdrawal in place.
    expect((await changeStatus(admin, alice, "reactivate")).status).toBe(200);
    expect(await userRow(alice.id)).toMatchObject({
      status: "active",
      sessionVersion: 1,
    });
    expect(
      (await db.select().from(schedules).where(eq(schedules.id, schedule!.id)))[0]!
        .enabled,
    ).toBe(false);
  });

  it("the worker never claims, and the scheduler never fires, for an owner who is not active", async () => {
    const { claimChatRun } = await import("@/lib/chat-run-worker");
    const { processDueSchedules } = await import("@/lib/schedules/scheduler");
    await db
      .update(users)
      .set({ status: "suspended" })
      .where(eq(users.id, alice.id));
    const inputs = {
      prompt: "hello",
      threadId: aliceThreadId,
      userMessageId: "msg-1",
      executionMode: "local",
    };
    // Rows left behind or enqueued in the instant before the suspension.
    const [stranded] = await db
      .insert(runs)
      .values({ userId: alice.id, threadId: aliceThreadId, skillSlug: "chat-turn", triggerType: "chat", status: "queued", inputs })
      .returning();
    const [skill] = await db
      .insert(skills)
      .values({
        slug: "lifecycle-scheduled",
        name: "Scheduled",
        ownerUserId: alice.id,
        systemPrompt: "Summarize.",
        modelId: "sonnet-4-6",
        mcpProviders: [],
        isStarter: false,
      })
      .returning();
    const now = new Date();
    const [schedule] = await db
      .insert(schedules)
      .values({
        userId: alice.id,
        skillId: skill!.id,
        cadence: "0 8 * * *",
        timezone: "UTC",
        enabled: true,
        nextRunAt: new Date(now.getTime() - 60_000),
      })
      .returning();

    expect(await claimChatRun({ db, workerId: "it-worker" })).toBeNull();
    expect(
      await claimChatRun({ db, runId: stranded!.id, workerId: "it-worker" }),
    ).toBeNull();
    expect(await processDueSchedules({ db, workerId: "it-worker", now })).toEqual({
      fired: 0,
      failed: 0,
    });
    expect(
      (await db.select().from(schedules).where(eq(schedules.id, schedule!.id)))[0]!
        .claimedAt,
    ).toBeNull();
    expect(
      await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.userId, alice.id), eq(runs.triggerType, "scheduled"))),
    ).toHaveLength(0);

    // The same rows are picked up once the owner is active again.
    await db.update(users).set({ status: "active" }).where(eq(users.id, alice.id));
    const claimed = await claimChatRun({ db, workerId: "it-worker" });
    expect(claimed?.id).toBe(stranded!.id);
  });

  it("refuses to suspend yourself or the last active admin", async () => {
    const self = await changeStatus(admin, admin, "suspend");
    expect(self.status).toBe(400);
    expect(await self.json()).toMatchObject({ error: "cannot_change_self" });

    // Two admins: one may suspend the other...
    expect((await changeStatus(admin, secondAdmin, "suspend")).status).toBe(200);
    expect((await changeStatus(admin, secondAdmin, "reactivate")).status).toBe(200);

    // ...but not when the target is the only active admin left. The actor
    // here was suspended a moment ago by someone else; the lifecycle counts
    // active admins under lock, not the session it was handed.
    await db.update(users).set({ status: "suspended" }).where(eq(users.id, admin.id));
    const { suspendUser } = await import("@/lib/user-lifecycle");
    await expect(
      suspendUser(secondAdmin.id, admin, "Rotation", { db }),
    ).resolves.toEqual({ ok: false, status: 409, error: "last_admin" });
    expect((await userRow(secondAdmin.id)).status).toBe("active");
  });
});
