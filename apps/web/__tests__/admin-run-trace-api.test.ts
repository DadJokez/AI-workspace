import type { SessionUser } from "@ai-workspace/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adminSession: SessionUser = {
  id: "admin-uuid",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
};

interface DbFixtures {
  runRows: Array<Record<string, unknown>>;
  eventRows: Array<Record<string, unknown>>;
  auditRows: Array<Record<string, unknown>>;
  recentAccessRows: Array<{ id: string }>;
  insertedAudit: Array<Record<string, unknown>>;
}

let fixtures: DbFixtures;

function setAdminResult(result: "admin" | "forbidden") {
  vi.doMock("@/lib/auth/requireAdmin", async () => {
    const { NextResponse } = await import("next/server");
    return {
      requireAdmin: async () =>
        result === "admin"
          ? { user: adminSession }
          : {
              error: NextResponse.json(
                { error: "forbidden" },
                { status: 403 },
              ),
            },
    };
  });
}

function installDbMock() {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    function select() {
      let table: unknown;
      let ordered = false;
      const query = {
        from(nextTable: unknown) {
          table = nextTable;
          return query;
        },
        leftJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          ordered = true;
          return query;
        },
        limit() {
          if (table === actual.runs) return Promise.resolve(fixtures.runRows);
          if (table === actual.runEvents) {
            return Promise.resolve(fixtures.eventRows);
          }
          if (table === actual.auditLog) {
            return Promise.resolve(
              ordered ? fixtures.auditRows : fixtures.recentAccessRows,
            );
          }
          return Promise.resolve([]);
        },
      };
      return query;
    }

    return {
      ...actual,
      getDb: () => ({
        select,
        insert: () => ({
          values: async (value: Record<string, unknown>) => {
            fixtures.insertedAudit.push(value);
          },
        }),
      }),
    };
  });
}

beforeEach(() => {
  fixtures = {
    runRows: [
      {
        id: "run-uuid",
        userId: "user-uuid",
        skillSlug: "chat-turn",
        status: "succeeded",
        triggerType: "chat",
        runtime: "bedrock",
        modelId: "sonnet-4-6",
        inputs: {
          prompt: "Inspect the repository",
          authorization: "Bearer should-not-leak",
        },
        outputs: { assistantText: "Done." },
        error: null,
        attemptCount: 1,
        startedAt: new Date("2026-07-15T01:00:00.000Z"),
        completedAt: new Date("2026-07-15T01:00:02.000Z"),
        createdAt: new Date("2026-07-15T01:00:00.000Z"),
        updatedAt: new Date("2026-07-15T01:00:02.000Z"),
        actorEmail: "user@example.com",
        actorName: "User",
      },
    ],
    eventRows: [
      {
        id: "event-uuid",
        sequence: 1,
        eventType: "provider_reasoning",
        status: "succeeded",
        label: "Captured provider reasoning",
        provider: "bedrock",
        toolName: null,
        toolCallId: null,
        input: null,
        output: { state: "available", blocks: [{ text: "Check the repo." }] },
        error: null,
        metadata: { signature: "should-not-leak" },
        occurredAt: new Date("2026-07-15T01:00:01.000Z"),
      },
    ],
    auditRows: [],
    recentAccessRows: [],
    insertedAudit: [],
  };
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("GET /api/admin/runs/[id]/trace", () => {
  it("denies non-admin access before reading trace data", async () => {
    setAdminResult("forbidden");
    installDbMock();
    const { GET } = await import("@/app/api/admin/runs/[id]/trace/route");

    const response = await GET(
      new Request("http://localhost/api/admin/runs/run-uuid/trace"),
      { params: Promise.resolve({ id: "run-uuid" }) },
    );

    expect(response.status).toBe(403);
    expect(fixtures.insertedAudit).toHaveLength(0);
  });

  it("returns a defense-in-depth redacted trace and audits access", async () => {
    setAdminResult("admin");
    installDbMock();
    const { GET } = await import("@/app/api/admin/runs/[id]/trace/route");

    const response = await GET(
      new Request("http://localhost/api/admin/runs/run-uuid/trace"),
      { params: Promise.resolve({ id: "run-uuid" }) },
    );
    const body = (await response.json()) as { trace: unknown };
    const serialized = JSON.stringify(body.trace);

    expect(response.status).toBe(200);
    expect(serialized).toContain("run-inspector.v1");
    expect(serialized).toContain("Check the repo.");
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).toContain("[redacted]");
    expect(fixtures.insertedAudit).toEqual([
      expect.objectContaining({
        actorUserId: adminSession.id,
        runId: "run-uuid",
        actionType: "run_trace_viewed",
        status: "succeeded",
      }),
    ]);
  });

  it("deduplicates polling access within the audit window", async () => {
    fixtures.recentAccessRows = [{ id: "existing-access" }];
    setAdminResult("admin");
    installDbMock();
    const { GET } = await import("@/app/api/admin/runs/[id]/trace/route");

    const response = await GET(
      new Request("http://localhost/api/admin/runs/run-uuid/trace"),
      { params: Promise.resolve({ id: "run-uuid" }) },
    );

    expect(response.status).toBe(200);
    expect(fixtures.insertedAudit).toHaveLength(0);
  });
});
