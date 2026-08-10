import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, searchContextResources } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  searchContextResources: vi.fn(),
}));

let ownedRows: Array<{ id: string }> = [];

vi.mock("@/lib/auth/requireSession", () => ({ requireSession }));
vi.mock("@/lib/context-shelf-server", () => ({ searchContextResources }));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));
vi.mock("@ai-workspace/db", () => {
  const query: Record<string, unknown> = {};
  query.from = () => query;
  query.where = () => query;
  query.limit = () => Promise.resolve(ownedRows);
  return {
    chatThreads: { id: "chatThreads.id", userId: "chatThreads.userId" },
    getDb: () => ({ select: () => query }),
  };
});

import { GET } from "@/app/api/context/resources/route";

const user = {
  id: "user-1",
  email: "rob@example.com",
  displayName: "Rob",
  role: "user",
};
const threadId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  ownedRows = [{ id: threadId }];
  requireSession.mockResolvedValue({ user });
  searchContextResources.mockResolvedValue({ results: [], scopes: [] });
});

describe("GET /api/context/resources (#738)", () => {
  it("searches only after confirming the current user owns the thread", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/context/resources?threadId=${threadId}&q=launch&scope=workspace`,
      ),
    );

    expect(response.status).toBe(200);
    expect(searchContextResources).toHaveBeenCalledWith(
      expect.objectContaining({
        user,
        threadId,
        query: "launch",
        scope: "workspace",
      }),
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns 404 without searching when the thread is outside the user scope", async () => {
    ownedRows = [];

    const response = await GET(
      new Request(
        `http://localhost/api/context/resources?threadId=${threadId}&q=launch`,
      ),
    );

    expect(response.status).toBe(404);
    expect(searchContextResources).not.toHaveBeenCalled();
  });

  it.each([
    ["scope=dropbox", "invalid_scope"],
    ["threadId=not-a-uuid", "invalid_thread_id"],
    [`q=${"a".repeat(201)}`, "query_too_large"],
  ])("rejects an invalid query contract: %s", async (query, error) => {
    const response = await GET(
      new Request(`http://localhost/api/context/resources?${query}`),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error });
    expect(searchContextResources).not.toHaveBeenCalled();
  });

  it("returns the shared session error before touching resources", async () => {
    requireSession.mockResolvedValue({
      error: Response.json({ error: "unauthorized" }, { status: 401 }),
    });

    const response = await GET(
      new Request("http://localhost/api/context/resources?q=launch"),
    );

    expect(response.status).toBe(401);
    expect(searchContextResources).not.toHaveBeenCalled();
  });
});
