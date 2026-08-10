import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDb, loadCommandPaletteIndex, requireSession } = vi.hoisted(() => ({
  getDb: vi.fn(() => ({ id: "db" })),
  loadCommandPaletteIndex: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("@ai-workspace/db", () => ({ getDb }));
vi.mock("@/lib/auth/requireSession", () => ({ requireSession }));
vi.mock("@/lib/command-palette-server", () => ({
  loadCommandPaletteIndex,
}));

import { GET } from "@/app/api/command-palette/route";

const user = {
  id: "user-palette",
  email: "casey@example.com",
  displayName: "Casey",
  role: "user",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ user });
  loadCommandPaletteIndex.mockResolvedValue({
    items: [],
    partialSections: [],
  });
});

describe("GET /api/command-palette", () => {
  it("builds the index for the authenticated user and treats thread context only as ranking input", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/command-palette?threadId=thread-current",
      ),
    );

    expect(response.status).toBe(200);
    expect(loadCommandPaletteIndex).toHaveBeenCalledWith({
      db: { id: "db" },
      user,
      currentThreadId: "thread-current",
    });
    expect(await response.json()).toMatchObject({
      items: [],
      isAdmin: false,
      partialSections: [],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("server-timing")).toMatch(
      /^command-palette;dur=/,
    );
  });

  it("does not touch workspace resources when the session is unauthorized", async () => {
    requireSession.mockResolvedValue({
      error: Response.json({ error: "unauthorized" }, { status: 401 }),
    });

    const response = await GET(
      new Request("http://localhost/api/command-palette"),
    );

    expect(response.status).toBe(401);
    expect(loadCommandPaletteIndex).not.toHaveBeenCalled();
  });

  it("does not expose admin destinations to regular users", async () => {
    const response = await GET(
      new Request("http://localhost/api/command-palette"),
    );

    expect(await response.json()).toMatchObject({ isAdmin: false });
  });
});
