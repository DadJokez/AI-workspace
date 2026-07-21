import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  chatMessages,
  chatThreads,
  createDb,
  schedules,
  skills,
  users,
} from "@ai-workspace/db";
import type { SessionUser } from "@ai-workspace/auth";
import { createArtifactsFromAssistantMessage } from "@/lib/workspace-artifacts";
import { storeOAuthConnection } from "@/lib/oauth/connection";

/**
 * #456: audit completeness against real Postgres — every asserted surface
 * writes its `audit_log` row through the REAL handler or the REAL shared
 * loader, so removing an audit write fails a blocking CI test. Companion to
 * the unit-level lane-parity tests in __tests__/execute-chat-turn.test.ts
 * (which pin that assistant-message and attestation audits are
 * lane-independent by construction).
 */

const DB_URL = process.env.DATABASE_URL;

// #479 retro-review: never green-by-skip in CI (see scoping suite).
if (!DB_URL && process.env.CI) {
  throw new Error(
    "audit integration suite: DATABASE_URL is empty in CI — the " +
      "INTEGRATION_DATABASE_URL plumbing is broken; refusing to green-by-skip.",
  );
}

// storeOAuthConnection encrypts tokens before persisting; any 32-byte key
// works for the test — nothing here leaves the throwaway database.
process.env.OAUTH_ENCRYPTION_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

let currentUser: SessionUser | null = null;
vi.mock("@/lib/auth/getSessionUser", () => ({
  getSessionUser: async () => currentUser,
}));

const suite = describe.skipIf(!DB_URL);

suite("audit completeness (real Postgres, real handlers)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 4 });

  let alice: SessionUser;
  let admin: SessionUser;
  let aliceThreadId: string;

  // Scoped by actor: audit_log rows deliberately survive user deletion
  // (actor nulls out), so rows from prior local runs linger in a shared dev
  // database. Each run seeds fresh user ids, making the actor filter exact.
  async function auditRows(actionType: string, actorUserId: string) {
    return db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actionType, actionType),
          eq(auditLog.actorUserId, actorUserId),
        ),
      );
  }

  beforeAll(async () => {
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    await db.delete(users);
    const [a, adm] = await db
      .insert(users)
      .values([
        {
          pingSubject: "audit-alice",
          email: "audit-alice@example.com",
          displayName: "Alice",
          role: "user",
        },
        {
          pingSubject: "audit-admin",
          email: "audit-admin@example.com",
          displayName: "Admin",
          role: "admin",
        },
      ])
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: a!.id,
        title: "Alice's thread",
        defaultModelId: "sonnet-4-6",
      })
      .returning();
    const asSession = (u: typeof a): SessionUser =>
      ({
        id: u!.id,
        email: u!.email,
        displayName: u!.displayName,
        role: u!.role,
      }) as SessionUser;
    alice = asSession(a);
    admin = asSession(adm);
    aliceThreadId = thread!.id;
  });

  afterAll(async () => {
    await db.delete(users);
  });

  it("audits an admin role change with the before/after pair", async () => {
    currentUser = admin;
    const { PATCH } = await import("@/app/api/admin/users/[id]/route");
    const res = await PATCH(
      new Request("http://test.local", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      }),
      { params: Promise.resolve({ id: alice.id }) },
    );
    expect(res.status).toBe(200);

    const rows = await auditRows("admin_user_role_update", admin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: admin.id,
      status: "succeeded",
      input: { subjectUserId: alice.id },
      metadata: { previousRole: "user", newRole: "admin" },
    });
  });

  it("audits schedule update and delete through the real routes", async () => {
    currentUser = alice;
    const [skill] = await db
      .insert(skills)
      .values({
        slug: `audit-skill-${Date.now()}`,
        name: "Audit skill",
        ownerUserId: alice.id,
        systemPrompt: "do the thing",
        modelId: "sonnet-4-6",
        mcpProviders: [],
      })
      .returning();
    const [schedule] = await db
      .insert(schedules)
      .values({
        userId: alice.id,
        skillId: skill!.id,
        cadence: "0 9 * * 1",
        timezone: "America/New_York",
        nextRunAt: new Date(Date.now() + 60_000),
      })
      .returning();

    const { PATCH, DELETE } = await import("@/app/api/schedules/[id]/route");
    const patchRes = await PATCH(
      new Request("http://test.local", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      { params: Promise.resolve({ id: schedule!.id }) },
    );
    expect(patchRes.status).toBe(200);
    const updates = await auditRows("schedule_update", alice.id);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      actorUserId: alice.id,
      input: { scheduleId: schedule!.id, skillId: skill!.id },
    });

    const deleteRes = await DELETE(new Request("http://test.local"), {
      params: Promise.resolve({ id: schedule!.id }),
    });
    expect(deleteRes.status).toBe(200);
    const deletes = await auditRows("schedule_delete", alice.id);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({
      actorUserId: alice.id,
      input: { scheduleId: schedule!.id },
    });
  });

  it("audits artifact creation via the shared loader both lanes call", async () => {
    const [message] = await db
      .insert(chatMessages)
      .values({
        threadId: aliceThreadId,
        role: "assistant",
        content: "reply",
      })
      .returning();

    const html = `<html><body>${"x".repeat(300)}</body></html>`;
    const created = await createArtifactsFromAssistantMessage({
      db,
      userId: alice.id,
      threadId: aliceThreadId,
      chatMessageId: message!.id,
      assistantText: '```html filename="report.html"\n' + html + "\n```",
      turnToolCalls: [],
      turnToolResults: [],
    });
    expect(created).toHaveLength(1);

    const rows = await auditRows("workspace_artifact_create", alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: alice.id,
      chatThreadId: aliceThreadId,
      chatMessageId: message!.id,
      input: {
        artifactId: created[0]!.id,
        filename: "report.html",
        versionNumber: 1,
      },
    });
  });

  it("audits a provider connection without any token material in the row", async () => {
    await storeOAuthConnection({
      db,
      userId: alice.id,
      provider: "github",
      accessToken: "super-secret-token",
      attestationReason: "integration test",
      attestationSource: "audit.integration.test",
    });

    const rows = await auditRows("mcp_connection_create", alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: alice.id,
      provider: "github",
      status: "succeeded",
    });
    expect(JSON.stringify(rows[0])).not.toContain("super-secret-token");
  });

  it("audits the user message on a chat send (real route, denied before model)", async () => {
    // Send into Alice's own thread but with an invalid body later — simplest
    // deterministic path: a normal send drives the full inline turn against
    // the fake Bedrock client; consume the stream so the turn completes.
    currentUser = alice;
    const { POST } = await import("@/app/api/chat/route");
    const res = await POST(
      new Request("http://test.local/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "audit this send",
          threadId: aliceThreadId,
        }),
      }),
    );
    expect(res.status).toBe(200);
    await res.text();

    const rows = await auditRows("chat_message_create", alice.id);
    const roles = rows.map(
      (row) => (row.input as { role?: string } | null)?.role,
    );
    expect(roles).toContain("user");
    const userRow = rows.find(
      (row) => (row.input as { role?: string } | null)?.role === "user",
    );
    expect(userRow).toMatchObject({
      actorUserId: alice.id,
      chatThreadId: aliceThreadId,
      status: "succeeded",
    });
  });
});
