import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const session: SessionUser = {
  id: "user-owner",
  email: "owner@example.com",
  displayName: "Owner",
  role: "user",
};

const fixedDate = new Date("2026-07-21T12:00:00.000Z");

let currentSession: SessionUser | null = session;
let selectRows: Array<Record<string, unknown>> = [];
let updateRows: Array<Record<string, unknown>> = [];
let setValue: Record<string, unknown> | undefined;
let equalityValues: unknown[] = [];
let orderDirections: string[] = [];

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentSession,
  }));
  vi.doMock("drizzle-orm", async () => {
    const actual = await vi.importActual<typeof import("drizzle-orm")>(
      "drizzle-orm",
    );
    return {
      ...actual,
      eq: (column: unknown, value: unknown) => {
        equalityValues.push(value);
        return { column, value };
      },
      and: (...conditions: unknown[]) => ({ conditions }),
      asc: (column: unknown) => {
        orderDirections.push("asc");
        return { column, direction: "asc" };
      },
      desc: (column: unknown) => {
        orderDirections.push("desc");
        return { column, direction: "desc" };
      },
    };
  });
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    const query: Record<string, unknown> = {};
    query.from = () => query;
    query.where = () => query;
    query.orderBy = (..._args: unknown[]) => query;
    query.limit = () => Promise.resolve(selectRows);
    query.set = (value: Record<string, unknown>) => {
      setValue = value;
      return query;
    };
    query.returning = () => Promise.resolve(updateRows);
    return {
      ...actual,
      getDb: () => ({
        select: () => query,
        update: () => query,
      }),
    };
  });
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/threads/thread-owned", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  currentSession = session;
  selectRows = [];
  updateRows = [];
  setValue = undefined;
  equalityValues = [];
  orderDirections = [];
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("GET /api/threads", () => {
  it("returns pinned metadata in pin-first, newest-first query order for the personal scope", async () => {
    selectRows = [
      {
        id: "thread-owned",
        userId: session.id,
        title: "Pinned chat",
        pinned: true,
        defaultModelId: "sonnet-4-6",
        previewSummary: null,
        previewSummaryUpdatedAt: null,
        titleSource: "auto",
        createdAt: fixedDate,
        updatedAt: fixedDate,
      },
    ];
    installMocks();

    const { GET } = await import("@/app/api/threads/route");
    const response = await GET(
      new Request("http://localhost/api/threads?limit=50&scope=mine"),
    );
    const body = (await response.json()) as {
      threads: Array<{ id: string; pinned: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.threads).toEqual([
      expect.objectContaining({ id: "thread-owned", pinned: true }),
    ]);
    expect(equalityValues).toContain(session.id);
    expect(orderDirections).toEqual(["desc", "desc", "asc"]);
  });
});

describe("PATCH /api/threads/[id]", () => {
  it("pins an owned thread without changing conversation recency", async () => {
    updateRows = [
      {
        id: "thread-owned",
        title: "Owned chat",
        pinned: true,
        titleSource: "auto",
        updatedAt: fixedDate,
      },
    ];
    installMocks();

    const { PATCH } = await import("@/app/api/threads/[id]/route");
    const response = await PATCH(patchRequest({ pinned: true }), {
      params: Promise.resolve({ id: "thread-owned" }),
    });

    expect(response.status).toBe(200);
    expect(setValue).toEqual({ pinned: true });
    expect(equalityValues).toEqual(
      expect.arrayContaining(["thread-owned", session.id]),
    );
  });

  it("returns 404 when the owner-scoped update cannot see the thread", async () => {
    updateRows = [];
    installMocks();

    const { PATCH } = await import("@/app/api/threads/[id]/route");
    const response = await PATCH(patchRequest({ pinned: true }), {
      params: Promise.resolve({ id: "thread-from-another-user" }),
    });

    expect(response.status).toBe(404);
    expect(equalityValues).toEqual(
      expect.arrayContaining(["thread-from-another-user", session.id]),
    );
  });

  it("preserves the existing owner-scoped rename behavior", async () => {
    updateRows = [
      {
        id: "thread-owned",
        title: "Renamed chat",
        pinned: false,
        titleSource: "manual",
        updatedAt: fixedDate,
      },
    ];
    installMocks();

    const { PATCH } = await import("@/app/api/threads/[id]/route");
    const response = await PATCH(patchRequest({ title: "  Renamed chat  " }), {
      params: Promise.resolve({ id: "thread-owned" }),
    });

    expect(response.status).toBe(200);
    expect(setValue).toMatchObject({
      title: "Renamed chat",
      titleSource: "manual",
      updatedAt: expect.any(Date),
    });
    expect(equalityValues).toEqual(
      expect.arrayContaining(["thread-owned", session.id]),
    );
  });

  it("rejects invalid or ambiguous metadata updates", async () => {
    installMocks();

    const { PATCH } = await import("@/app/api/threads/[id]/route");
    const invalidPinned = await PATCH(patchRequest({ pinned: "yes" }), {
      params: Promise.resolve({ id: "thread-owned" }),
    });
    const multipleFields = await PATCH(
      patchRequest({ title: "Rename", pinned: true }),
      { params: Promise.resolve({ id: "thread-owned" }) },
    );

    expect(invalidPinned.status).toBe(400);
    expect(multipleFields.status).toBe(400);
    expect(setValue).toBeUndefined();
  });
});
