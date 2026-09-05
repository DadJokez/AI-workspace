import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatMessages,
  chatThreads,
  createDb,
  runEvents,
  runs,
  skills,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";
import type { SessionUser } from "@ai-workspace/auth";
import { asc, eq, sql } from "drizzle-orm";
import { collectText } from "../__tests__/helpers/collect-text";

/**
 * #444: per-user scoping, proven against real Postgres through the REAL
 * route handlers — no db mocks, so the WHERE clauses themselves are under
 * test (the unit-lane mocks structurally discard them; that gap is the
 * finding this suite closes). Two users + an admin; every spec asserts a
 * cross-user access dies at the scope predicate.
 *
 * The #445 regression (admin writing into another user's thread via the
 * read-side scope helper) is pinned here explicitly.
 */

const DB_URL = process.env.DATABASE_URL;

// #479 retro-review: locally the suite may skip without a database, but in
// CI a missing URL means the env plumbing broke — skipping would turn this
// gate decorative while staying green. Fail closed instead.
if (!DB_URL && process.env.CI) {
  throw new Error(
    "scoping integration suite: DATABASE_URL is empty in CI — the " +
      "INTEGRATION_DATABASE_URL plumbing is broken; refusing to green-by-skip.",
  );
}

// The session mock: routes call getSessionUser(); tests choose the actor.
let currentUser: SessionUser | null = null;
vi.mock("@/lib/auth/getSessionUser", () => ({
  getSessionUser: async () => currentUser,
}));

const suite = describe.skipIf(!DB_URL);

suite("cross-user scoping (real Postgres, real handlers)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 4 });

  interface Seeded {
    alice: SessionUser;
    bob: SessionUser;
    admin: SessionUser;
    aliceThreadId: string;
    aliceMessageId: string;
    aliceArtifactId: string;
    starterSkillId: string;
  }
  let seeded: Seeded;

  async function seed(): Promise<Seeded> {
    const [alice, bob, admin] = await db
      .insert(users)
      .values([
        {
          pingSubject: "it-alice",
          email: "alice@example.com",
          displayName: "Alice",
          role: "user",
        },
        {
          pingSubject: "it-bob",
          email: "bob@example.com",
          displayName: "Bob",
          role: "user",
        },
        {
          pingSubject: "it-admin",
          email: "admin@example.com",
          displayName: "Admin",
          role: "admin",
        },
      ])
      .returning();

    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId: alice!.id,
        title: "Alice's private thread",
        defaultModelId: "sonnet-4-6",
      })
      .returning();

    const [message] = await db
      .insert(chatMessages)
      .values({
        threadId: thread!.id,
        role: "user",
        content: "alice's secret question",
      })
      .returning();

    const [artifact] = await db
      .insert(workspaceArtifacts)
      .values({
        userId: alice!.id,
        threadId: thread!.id,
        chatMessageId: message!.id,
        title: "alice-report.html",
        filename: "alice-report.html",
        kind: "document",
        mimeType: "text/html",
        content: "<html>alice-secret</html>",
        sizeBytes: 25,
        source: "assistant-code-block",
      })
      .returning();

    // #827: a starter skill is the widest audience the skill-history leak
    // had (every user can open it), so it is the fixture for that regression.
    const [starterSkill] = await db
      .insert(skills)
      .values({
        slug: "it-starter-brief",
        name: "Starter brief",
        ownerUserId: alice!.id,
        systemPrompt: "Summarize the day.",
        modelId: "sonnet-4-6",
        mcpProviders: [],
        isStarter: true,
      })
      .returning();
    await db.insert(runs).values([
      {
        userId: alice!.id,
        skillId: starterSkill!.id,
        triggerType: "skill",
        status: "failed",
        error: "alice-private-run-error",
      },
      {
        userId: bob!.id,
        skillId: starterSkill!.id,
        triggerType: "skill",
        status: "failed",
        error: "bob-private-run-error",
      },
    ]);

    const asSession = (u: typeof alice): SessionUser =>
      ({
        id: u!.id,
        email: u!.email,
        displayName: u!.displayName,
        role: u!.role,
      }) as SessionUser;

    return {
      alice: asSession(alice),
      bob: asSession(bob),
      admin: asSession(admin),
      aliceThreadId: thread!.id,
      aliceMessageId: message!.id,
      aliceArtifactId: artifact!.id,
      starterSkillId: starterSkill!.id,
    };
  }

  beforeAll(async () => {
    // Fail fast (rather than skip) if the URL points somewhere unmigrated.
    await db.select({ id: users.id }).from(users).limit(1);
  });

  beforeEach(async () => {
    // users cascade wipes threads/messages/artifacts/runs between specs.
    await db.delete(users);
    seeded = await seed();
  });

  afterAll(async () => {
    await db.delete(users);
  });

  it("thread list returns only the caller's threads", async () => {
    const { GET } = await import("@/app/api/threads/route");
    const listReq = () => new Request("http://test.local/api/threads");
    currentUser = seeded.bob;
    const res = await GET(listReq());
    const body = (await res.json()) as { threads: Array<{ id: string }> };
    expect(res.status).toBe(200);
    expect(body.threads).toHaveLength(0);

    currentUser = seeded.alice;
    const own = (await (await GET(listReq())).json()) as {
      threads: Array<{ id: string }>;
    };
    expect(own.threads.map((t) => t.id)).toEqual([seeded.aliceThreadId]);
  });

  it("thread detail 404s for another user", async () => {
    const { GET } = await import("@/app/api/threads/[id]/route");
    currentUser = seeded.bob;
    const res = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceThreadId }),
    });
    expect(res.status).toBe(404);
  });

  it("thread messages 404 for another user and load for the owner", async () => {
    const { GET } = await import("@/app/api/threads/[id]/messages/route");
    currentUser = seeded.bob;
    const denied = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceThreadId }),
    });
    expect(denied.status).toBe(404);

    currentUser = seeded.alice;
    const ok = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceThreadId }),
    });
    expect(ok.status).toBe(200);
  });

  it("thread delete 404s cross-user and leaves the row intact", async () => {
    const { DELETE } = await import("@/app/api/threads/[id]/route");
    currentUser = seeded.bob;
    const res = await DELETE(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceThreadId }),
    });
    expect(res.status).toBe(404);
    const still = await db.select({ id: chatThreads.id }).from(chatThreads);
    expect(still).toHaveLength(1);
  });

  it("#445 regression: an ADMIN cannot post into another user's thread", async () => {
    const { POST } = await import("@/app/api/chat/route");
    currentUser = seeded.admin;
    const res = await POST(
      new Request("http://test.local/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "admin injecting into alice's thread",
          threadId: seeded.aliceThreadId,
        }),
      }),
    );
    expect(res.status).toBe(404);
    // No message row leaked in.
    const rows = await db
      .select({ id: chatMessages.id })
      .from(chatMessages);
    expect(rows).toHaveLength(1);
  });

  it("keeps the conversation tail when an edit target disappears at update time", async () => {
    const [target, tail] = await db
      .insert(chatMessages)
      .values([
        {
          threadId: seeded.aliceThreadId,
          role: "user",
          content: "edit this question",
        },
        {
          threadId: seeded.aliceThreadId,
          role: "assistant",
          content: "keep this answer if the edit cannot be applied",
        },
      ])
      .returning();

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_skip_chat_message_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NULL;
      END;
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER test_skip_chat_message_update
      BEFORE UPDATE ON chat_messages
      FOR EACH ROW
      EXECUTE FUNCTION test_skip_chat_message_update()
    `);

    try {
      const { POST } = await import("@/app/api/chat/route");
      currentUser = seeded.alice;
      const res = await POST(
        new Request("http://test.local/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "edited question",
            threadId: seeded.aliceThreadId,
            replaceMessageId: target!.id,
          }),
        }),
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "message_not_found" });
      const remaining = await db
        .select({ id: chatMessages.id, content: chatMessages.content })
        .from(chatMessages)
        .where(eq(chatMessages.threadId, seeded.aliceThreadId))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
      expect(remaining).toEqual(
        expect.arrayContaining([
          { id: target!.id, content: "edit this question" },
          {
            id: tail!.id,
            content: "keep this answer if the edit cannot be applied",
          },
        ]),
      );
    } finally {
      await db.execute(
        sql`DROP TRIGGER IF EXISTS test_skip_chat_message_update ON chat_messages`,
      );
      await db.execute(
        sql`DROP FUNCTION IF EXISTS test_skip_chat_message_update()`,
      );
    }
  });

  it("admin READ visibility on threads remains (intentional product behavior)", async () => {
    const { GET } = await import("@/app/api/threads/[id]/route");
    currentUser = seeded.admin;
    const res = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceThreadId }),
    });
    expect(res.status).toBe(200);
  });

  it("artifact download is denied cross-user", async () => {
    const { GET } = await import(
      "@/app/api/workspace/artifacts/[id]/download/route"
    );
    currentUser = seeded.bob;
    const res = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceArtifactId }),
    });
    expect([403, 404]).toContain(res.status);

    currentUser = seeded.alice;
    const ok = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceArtifactId }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("alice-secret");
  });

  it("run status poll (#447) 404s cross-user and returns the cursor for the owner", async () => {
    const { GET } = await import("@/app/api/runs/[id]/status/route");
    const [run] = await db
      .insert(runs)
      .values({
        userId: seeded.alice.id,
        threadId: seeded.aliceThreadId,
        skillSlug: "chat-turn",
        status: "running",
      })
      .returning();
    await db.insert(runEvents).values({
      runId: run!.id,
      sequence: 2,
      eventType: "provider_run_started",
      label: "Started bedrock run",
    });

    currentUser = seeded.bob;
    const denied = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: run!.id }),
    });
    expect(denied.status).toBe(404);

    currentUser = seeded.alice;
    const ok = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: run!.id }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      run: { id: string; status: string; latestEventSequence: number | null };
    };
    expect(body.run.id).toBe(run!.id);
    expect(body.run.status).toBe("running");
    expect(body.run.latestEventSequence).toBe(2);
  });

  it("thread export is denied cross-user", async () => {
    const { GET } = await import("@/app/api/threads/[id]/export/route");
    currentUser = seeded.bob;
    const res = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceThreadId }),
    });
    expect(res.status).toBe(404);
  });

  // #827/#846: the skill detail page is a real server component; these drive
  // it directly (as invite-page.test.ts does) so the runs WHERE clause at
  // app/skills/[id]/page.tsx is under test against real Postgres.
  const renderSkillDetail = async (skillId: string) => {
    const { default: SkillDetailPage } = await import("@/app/skills/[id]/page");
    return SkillDetailPage({ params: Promise.resolve({ id: skillId }) });
  };

  it("#827 regression: skill detail run history lists only the caller's runs", async () => {
    currentUser = seeded.bob;
    const asBob = collectText(await renderSkillDetail(seeded.starterSkillId));
    expect(asBob).toContain("bob-private-run-error");
    expect(asBob).not.toContain("alice-private-run-error");

    currentUser = seeded.alice;
    const asAlice = collectText(
      await renderSkillDetail(seeded.starterSkillId),
    );
    expect(asAlice).toContain("alice-private-run-error");
    expect(asAlice).not.toContain("bob-private-run-error");
  });

  it("skill detail is a personal surface: admin sees only their own runs", async () => {
    // Deliberately no userScope() bypass here; admins use /admin/runs.
    currentUser = seeded.admin;
    const asAdmin = collectText(
      await renderSkillDetail(seeded.starterSkillId),
    );
    expect(asAdmin).not.toContain("alice-private-run-error");
    expect(asAdmin).not.toContain("bob-private-run-error");
    expect(asAdmin).toContain("No runs yet.");
  });

  it("skill detail 404s for a user with no access", async () => {
    const [privateSkill] = await db
      .insert(skills)
      .values({
        slug: "it-alice-private",
        name: "Alice's private skill",
        ownerUserId: seeded.alice.id,
        systemPrompt: "Private.",
        modelId: "sonnet-4-6",
        mcpProviders: [],
        isStarter: false,
      })
      .returning();
    currentUser = seeded.bob;
    // Next's notFound() throws; the page never reaches the run history.
    await expect(renderSkillDetail(privateSkill!.id)).rejects.toThrow();
  });
});
