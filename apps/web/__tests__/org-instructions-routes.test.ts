import type { SessionUser } from "@ai-workspace/auth";
import type { OrgInstruction } from "@ai-workspace/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #438 PR B — the organization layer's routes. Everyone reads the approved
 * document; the write gate is the existing `requireAdmin` (real module;
 * only the session resolver is mocked). The table comes from the real
 * schema so the UPDATE's WHERE is rendered and asserted, not discarded.
 */
const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  loadApprovedOrgInstructionRows: vi.fn(),
  inserted: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ set: Record<string, unknown>; where: SQL }>,
  updateResult: [] as OrgInstruction[],
}));

vi.mock("@/lib/auth/requireSession", () => ({
  requireSession: mocks.requireSession,
}));
vi.mock("@/lib/org-instructions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/org-instructions")>();
  return {
    ...actual,
    loadApprovedOrgInstructionRows: mocks.loadApprovedOrgInstructionRows,
  };
});
vi.mock("@ai-workspace/db", async () => {
  const schema = await import("@ai-workspace/db/schema");
  return {
    ...schema,
    getDb: () => ({
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          returning: async () => {
            mocks.inserted.push(value);
            return [row({ id: NEW_ID, ...value })];
          },
        }),
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: (where: SQL) => ({
            returning: async () => {
              mocks.updates.push({ set: value, where });
              return mocks.updateResult;
            },
          }),
        }),
      }),
    }),
  };
});

import { GET, POST } from "@/app/api/org-instructions/route";
import { PATCH } from "@/app/api/org-instructions/[id]/route";

const ADMIN: SessionUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};
const USER: SessionUser = {
  id: "00000000-0000-4000-8000-000000000402",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};
const NEW_ID = "00000000-0000-4000-8000-000000000999";
const ROW_ID = "00000000-0000-4000-8000-000000000501";

function row(overrides: Partial<OrgInstruction> & { id: string }): OrgInstruction {
  const now = new Date("2026-09-06T12:00:00Z");
  return {
    content: "Our fiscal year starts in July.",
    status: "approved",
    authoredBy: ADMIN.id,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/org-instructions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/org-instructions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function renderWhere(where: SQL) {
  return new PgDialect().sqlToQuery(where);
}

const unauthorized = {
  error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserted.length = 0;
  mocks.updates.length = 0;
  mocks.updateResult = [];
  mocks.loadApprovedOrgInstructionRows.mockResolvedValue([]);
});

describe("GET /api/org-instructions (#438)", () => {
  it("returns the approved document to every signed-in user; edit rights only for admins", async () => {
    const approved = row({ id: ROW_ID });
    mocks.loadApprovedOrgInstructionRows.mockResolvedValue([approved]);

    mocks.requireSession.mockResolvedValue({ user: USER });
    const asUser = await GET();
    expect(asUser.status).toBe(200);
    const userBody = (await asUser.json()) as {
      approvedMarkdown: string;
      items: Array<{ id: string; content: string }>;
      canEdit: boolean;
    };
    expect(userBody.canEdit).toBe(false);
    expect(userBody.approvedMarkdown).toContain(
      "# Organization Standing Instructions",
    );
    expect(userBody.approvedMarkdown).toContain("Our fiscal year starts in July.");
    expect(userBody.items).toEqual([
      expect.objectContaining({ id: ROW_ID, content: approved.content }),
    ]);

    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    const asAdmin = await GET();
    expect(((await asAdmin.json()) as { canEdit: boolean }).canEdit).toBe(true);
    expect(mocks.loadApprovedOrgInstructionRows).toHaveBeenCalledTimes(2);
  });

  it("requires a session", async () => {
    mocks.requireSession.mockResolvedValue(unauthorized);
    expect((await GET()).status).toBe(401);
    expect(mocks.loadApprovedOrgInstructionRows).not.toHaveBeenCalled();
  });
});

describe("POST /api/org-instructions (#438)", () => {
  it("refuses a non-admin with 403 and writes nothing", async () => {
    mocks.requireSession.mockResolvedValue({ user: USER });
    const response = await post({ content: "Our fiscal year starts in July." });
    expect(response.status).toBe(403);
    expect(mocks.inserted).toEqual([]);
  });

  it("lets an admin add an instruction that lands approved and attributed to them", async () => {
    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    const response = await post({ content: "  Our fiscal year starts in July.  " });
    expect(response.status).toBe(201);
    expect(mocks.inserted).toEqual([
      {
        content: "Our fiscal year starts in July.",
        status: "approved",
        authoredBy: ADMIN.id,
      },
    ]);
    expect(await response.json()).toMatchObject({
      item: {
        id: NEW_ID,
        status: "approved",
        content: "Our fiscal year starts in July.",
        authoredBy: ADMIN.id,
      },
    });
  });

  it("rejects empty, oversized, non-string and malformed bodies", async () => {
    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    for (const body of [{ content: "   " }, { content: "x".repeat(4_001) }, { content: 7 }, {}]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_content" });
    }
    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json" });
    expect(mocks.inserted).toEqual([]);
  });
});

describe("PATCH /api/org-instructions/[id] (#438)", () => {
  it("refuses a non-admin with 403 and updates nothing", async () => {
    mocks.requireSession.mockResolvedValue({ user: USER });
    const response = await patch(ROW_ID, { action: "archive" });
    expect(response.status).toBe(403);
    expect(mocks.updates).toEqual([]);
  });

  it("archives (never deletes) an approved row for an admin", async () => {
    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    mocks.updateResult = [row({ id: ROW_ID, status: "archived" })];
    const response = await patch(ROW_ID, { action: "archive" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      item: { id: ROW_ID, status: "archived" },
    });
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0]!.set).toEqual({
      status: "archived",
      updatedAt: expect.any(Date),
    });
    // Only approved rows are addressable: id AND status = 'approved'.
    const where = renderWhere(mocks.updates[0]!.where);
    expect(where.sql).toContain('"id"');
    expect(where.sql).toContain('"status"');
    expect(where.params).toEqual([ROW_ID, "approved"]);
  });

  it("edits the text and moves attribution to the editing admin", async () => {
    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    mocks.updateResult = [row({ id: ROW_ID, content: "Starts in August." })];
    const response = await patch(ROW_ID, {
      action: "edit",
      content: " Starts in August. ",
    });
    expect(response.status).toBe(200);
    expect(mocks.updates[0]!.set).toEqual({
      content: "Starts in August.",
      authoredBy: ADMIN.id,
      updatedAt: expect.any(Date),
    });
    expect(renderWhere(mocks.updates[0]!.where).params).toEqual([
      ROW_ID,
      "approved",
    ]);
  });

  it("rejects an empty edit and an unknown action before touching the database", async () => {
    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    const empty = await patch(ROW_ID, { action: "edit", content: "  " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "invalid_content" });
    const bogus = await patch(ROW_ID, { action: "dismiss" });
    expect(bogus.status).toBe(400);
    expect(await bogus.json()).toEqual({ error: "invalid_action" });
    expect(mocks.updates).toEqual([]);
  });

  it("returns 404 when the row is unknown or already archived", async () => {
    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    mocks.updateResult = [];
    const response = await patch(ROW_ID, { action: "archive" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "org_instruction_not_found" });
  });
});
