import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, orgInstructions, users } from "@ai-workspace/db";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * #438 PR B: the organization layer against real Postgres through the REAL
 * route handlers. The property this suite exists for is the one a db mock
 * cannot prove — `org_instructions.authored_by` is `ON DELETE SET NULL`, so
 * offboarding the admin who wrote the org document keeps the document
 * (Rob's decision, 2026-09-06, over a Vault-scoped design whose
 * `user_memory_items.user_id` cascades).
 */

const DB_URL = process.env.DATABASE_URL;

// #479 retro-review: never green-by-skip in CI (see scoping suite).
if (!DB_URL && process.env.CI) {
  throw new Error(
    "org-instructions integration suite: DATABASE_URL is empty in CI — the " +
      "INTEGRATION_DATABASE_URL plumbing is broken; refusing to green-by-skip.",
  );
}

let currentUser: SessionUser | null = null;
vi.mock("@/lib/auth/getSessionUser", () => ({
  getSessionUser: async () => currentUser,
}));

const suite = describe.skipIf(!DB_URL);

suite("organization standing instructions (real Postgres, real handlers)", () => {
  const db = createDb({ url: DB_URL ?? "", max: 4 });

  let admin: SessionUser;
  let casey: SessionUser;

  const asSession = (u: typeof users.$inferSelect): SessionUser => ({
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
  });

  beforeEach(async () => {
    // Org rows outlive users by design, so they need their own reset.
    await db.delete(orgInstructions);
    await db.delete(users);
    const [adm, usr] = await db
      .insert(users)
      .values([
        {
          pingSubject: "it-org-admin",
          email: "org-admin@example.com",
          displayName: "Org Admin",
          role: "admin",
        },
        {
          pingSubject: "it-org-casey",
          email: "casey@example.com",
          displayName: "Casey",
          role: "user",
        },
      ])
      .returning();
    admin = asSession(adm!);
    casey = asSession(usr!);
  });

  afterAll(async () => {
    await db.delete(orgInstructions);
    await db.delete(users);
  });

  async function post(content: string) {
    const { POST } = await import("@/app/api/org-instructions/route");
    return POST(
      new Request("http://test.local/api/org-instructions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    );
  }

  async function get() {
    const { GET } = await import("@/app/api/org-instructions/route");
    return (await GET()).json() as Promise<{
      approvedMarkdown: string;
      items: Array<{ id: string; content: string; authoredBy: string | null }>;
      canEdit: boolean;
    }>;
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const { PATCH } = await import("@/app/api/org-instructions/[id]/route");
    return PATCH(
      new Request(`http://test.local/api/org-instructions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("admin writes land approved and attributed; a non-admin is refused and writes nothing", async () => {
    currentUser = casey;
    expect((await post("Our fiscal year starts in July.")).status).toBe(403);
    expect(await db.select().from(orgInstructions)).toEqual([]);

    currentUser = admin;
    const created = await post("Our fiscal year starts in July.");
    expect(created.status).toBe(201);
    const rows = await db.select().from(orgInstructions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: "Our fiscal year starts in July.",
      status: "approved",
      authoredBy: admin.id,
    });
  });

  it("everyone reads only approved rows; only admins may edit", async () => {
    await db.insert(orgInstructions).values([
      { content: "Retired rule.", status: "archived", authoredBy: admin.id },
      { content: "Always cite Salesforce record IDs.", authoredBy: admin.id },
    ]);

    currentUser = casey;
    const asCasey = await get();
    expect(asCasey.canEdit).toBe(false);
    expect(asCasey.items.map((item) => item.content)).toEqual([
      "Always cite Salesforce record IDs.",
    ]);
    expect(asCasey.approvedMarkdown).not.toContain("Retired rule.");

    currentUser = admin;
    expect((await get()).canEdit).toBe(true);
  });

  it("deleting the authoring admin keeps the org row and nulls authored_by (ON DELETE SET NULL)", async () => {
    currentUser = admin;
    const created = (await (await post("Our fiscal year starts in July.")).json()) as {
      item: { id: string; authoredBy: string | null };
    };
    expect(created.item.authoredBy).toBe(admin.id);

    await db.delete(users).where(eq(users.id, admin.id));

    const [survivor] = await db
      .select()
      .from(orgInstructions)
      .where(eq(orgInstructions.id, created.item.id));
    expect(survivor).toMatchObject({
      id: created.item.id,
      content: "Our fiscal year starts in July.",
      status: "approved",
      authoredBy: null,
    });

    // And it still loads for everyone.
    currentUser = casey;
    expect((await get()).items.map((item) => item.id)).toEqual([created.item.id]);
  });

  it("archive retires the row for every reader; a non-admin cannot archive", async () => {
    currentUser = admin;
    const created = (await (await post("Our fiscal year starts in July.")).json()) as {
      item: { id: string };
    };

    currentUser = casey;
    expect((await patch(created.item.id, { action: "archive" })).status).toBe(403);
    expect((await get()).items).toHaveLength(1);

    currentUser = admin;
    expect((await patch(created.item.id, { action: "archive" })).status).toBe(200);
    expect((await get()).items).toEqual([]);
    // Archived, not deleted: the row is still there for the audit trail.
    const [archived] = await db
      .select()
      .from(orgInstructions)
      .where(eq(orgInstructions.id, created.item.id));
    expect(archived?.status).toBe("archived");
    // An archived row is no longer addressable.
    expect((await patch(created.item.id, { action: "archive" })).status).toBe(404);
  });
});
