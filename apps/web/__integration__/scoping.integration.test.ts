import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatMessages,
  chatThreads,
  createDb,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";
import type { SessionUser } from "@ai-workspace/auth";

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

  it("thread export is denied cross-user", async () => {
    const { GET } = await import("@/app/api/threads/[id]/export/route");
    currentUser = seeded.bob;
    const res = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ id: seeded.aliceThreadId }),
    });
    expect(res.status).toBe(404);
  });
});
