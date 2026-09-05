import type { SessionUser } from "@ai-workspace/auth";
import type { UserMemoryItem } from "@ai-workspace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #438 PR B — the organization layer's write and read scoping on the Vault
 * routes. The write gate is the existing `requireAdmin` (real module; only
 * the session resolver is mocked), the read path hands every user the
 * approved org document and edit rights only to admins.
 */
const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  loadUserMemoryItems: vi.fn(),
  loadOrgMemoryItems: vi.fn(),
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/requireSession", () => ({
  requireSession: mocks.requireSession,
}));
vi.mock("@/lib/vault-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault-memory")>();
  return {
    ...actual,
    loadUserMemoryItems: mocks.loadUserMemoryItems,
    loadOrgMemoryItems: mocks.loadOrgMemoryItems,
  };
});
vi.mock("@ai-workspace/db", () => ({
  userMemoryItems: {},
  getDb: () => ({
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        returning: async () => {
          mocks.inserted.push(value);
          return [row({ id: "00000000-0000-4000-8000-000000000999", ...value })];
        },
      }),
    }),
  }),
}));

import { GET, POST } from "@/app/api/vault/memory/route";

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

function row(overrides: Partial<UserMemoryItem> & { id: string }): UserMemoryItem {
  const now = new Date("2026-09-05T12:00:00Z");
  return {
    userId: ADMIN.id,
    scope: "user",
    status: "approved",
    category: "organization",
    title: "Fiscal year",
    bodyMd: "Our fiscal year starts in July.",
    confidence: 100,
    reason: null,
    sourceThreadId: null,
    sourceMessageIds: [],
    suggestedBy: "admin",
    approvedBy: ADMIN.id,
    approvedAt: now,
    dismissedAt: null,
    archivedAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/vault/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserted.length = 0;
  mocks.loadUserMemoryItems.mockResolvedValue([]);
  mocks.loadOrgMemoryItems.mockResolvedValue([]);
});

describe("organization standing instructions on /api/vault/memory (#438)", () => {
  it("refuses an org-scoped write from a non-admin with 403 and writes nothing", async () => {
    mocks.requireSession.mockResolvedValue({ user: USER });
    const response = await post({
      scope: "org",
      title: "Fiscal year",
      bodyMd: "Our fiscal year starts in July.",
    });
    expect(response.status).toBe(403);
    expect(mocks.inserted).toEqual([]);
  });

  it("lets an admin add an org instruction that lands approved with scope org", async () => {
    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    const response = await post({
      scope: "org",
      title: "Fiscal year",
      bodyMd: "Our fiscal year starts in July.",
    });
    expect(response.status).toBe(201);
    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.inserted[0]).toMatchObject({
      userId: ADMIN.id,
      scope: "org",
      status: "approved",
      category: "organization",
      suggestedBy: "admin",
      approvedBy: ADMIN.id,
    });
    expect(await response.json()).toMatchObject({
      item: { scope: "org", status: "approved", title: "Fiscal year" },
    });
  });

  it("defaults to personal scope and rejects unknown scopes", async () => {
    mocks.requireSession.mockResolvedValue({ user: USER });
    const personal = await post({ title: "My team", bodyMd: "I sit with RevOps." });
    expect(personal.status).toBe(201);
    expect(mocks.inserted[0]).toMatchObject({
      userId: USER.id,
      scope: "user",
      suggestedBy: "user",
    });

    const bogus = await post({ scope: "team", title: "x", bodyMd: "y" });
    expect(bogus.status).toBe(400);
    expect(await bogus.json()).toMatchObject({ error: "invalid_scope" });
    expect(mocks.inserted).toHaveLength(1);
  });

  it("returns only the approved org document to every user; edit rights only for admins", async () => {
    const approved = row({
      id: "00000000-0000-4000-8000-000000000501",
      scope: "org",
    });
    mocks.loadOrgMemoryItems.mockResolvedValue([approved]);

    mocks.requireSession.mockResolvedValue({ user: USER });
    const asUser = await GET();
    expect(asUser.status).toBe(200);
    const userBody = (await asUser.json()) as {
      org: { approvedMarkdown: string; approvedItems: Array<{ id: string; scope: string }>; canEdit: boolean };
    };
    expect(mocks.loadOrgMemoryItems).toHaveBeenLastCalledWith(expect.anything(), ["approved"]);
    expect(mocks.loadUserMemoryItems).toHaveBeenLastCalledWith(expect.anything(), USER.id, [
      "approved",
      "suggested",
    ]);
    expect(userBody.org.canEdit).toBe(false);
    expect(userBody.org.approvedMarkdown).toContain("# Organization Standing Instructions");
    expect(userBody.org.approvedMarkdown).toContain("Our fiscal year starts in July.");
    expect(userBody.org.approvedItems).toEqual([
      expect.objectContaining({ id: approved.id, scope: "org" }),
    ]);

    mocks.requireSession.mockResolvedValue({ user: ADMIN });
    const asAdmin = await GET();
    const adminBody = (await asAdmin.json()) as { org: { canEdit: boolean } };
    expect(adminBody.org.canEdit).toBe(true);
  });
});
