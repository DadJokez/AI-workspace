import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

/**
 * #447: the slim pending-run poll endpoint. Response-shape and gating tests;
 * the WHERE-clause scoping itself is proven against real Postgres in
 * __integration__/scoping.integration.test.ts.
 */

const session: SessionUser = {
  id: "user-uuid",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

const fixedDate = new Date("2026-07-19T12:00:00.000Z");

let currentSession: SessionUser | null = session;
let runRows: Array<{
  id: string;
  userId: string;
  status: string;
  outputs?: unknown;
  updatedAt: Date;
}> = [];
let eventRows: Array<{ latestEventSequence: number | null }> = [];
const auditAdminDataAccess = vi.fn();

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentSession,
  }));
  vi.doMock("@/lib/admin-data-access", () => ({
    adminDataAccessJustification: (request: Request) =>
      request.headers.get("x-admin-access-justification"),
    auditAdminDataAccess,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    // The route issues two selects: runs (with .limit) then run_events
    // (awaited directly). Dispatch on the table passed to .from().
    const makeQuery = () => {
      let rows: unknown[] = [];
      const query = {
        from(table: unknown) {
          rows = table === actual.runs ? runRows : eventRows;
          return query;
        },
        where() {
          return {
            limit: () => Promise.resolve(rows),
            then: (
              resolve: (value: unknown[]) => unknown,
              reject: (reason?: unknown) => unknown,
            ) => Promise.resolve(rows).then(resolve, reject),
          };
        },
      };
      return query;
    };
    return {
      ...actual,
      getDb: () =>
        ({
          select: () => makeQuery(),
        }) as never,
    };
  });
}

beforeEach(() => {
  currentSession = session;
  runRows = [
    {
      id: "run-1",
      userId: session.id,
      status: "running",
      outputs: { usage: { tokensIn: 8_000, tokensOut: 400 } },
      updatedAt: fixedDate,
    },
  ];
  eventRows = [{ latestEventSequence: 7 }];
  auditAdminDataAccess.mockReset();
  auditAdminDataAccess.mockResolvedValue("skipped");
});

afterEach(() => {
  vi.resetModules();
});

describe("GET /api/runs/[id]/status", () => {
  it("returns 401 without a session", async () => {
    currentSession = null;
    installMocks();

    const { GET } = await import("@/app/api/runs/[id]/status/route");
    const res = await GET(new Request("http://localhost/api/runs/run-1/status"), {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 404 when the run is not visible to the session", async () => {
    runRows = [];
    installMocks();

    const { GET } = await import("@/app/api/runs/[id]/status/route");
    const res = await GET(new Request("http://localhost/api/runs/nope/status"), {
      params: Promise.resolve({ id: "nope" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "run_not_found" });
  });

  it("returns the slim status snapshot — no messages, events, or artifacts", async () => {
    installMocks();

    const { GET } = await import("@/app/api/runs/[id]/status/route");
    const res = await GET(new Request("http://localhost/api/runs/run-1/status"), {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      run: {
        id: "run-1",
        status: "running",
        updatedAt: fixedDate.toISOString(),
        latestEventSequence: 7,
        liveTokens: 8_400,
      },
    });
  });

  it("returns null telemetry for malformed run output", async () => {
    runRows[0]!.outputs = {
      usage: { tokensIn: "not-a-number", tokensOut: -1 },
    };
    installMocks();

    const { GET } = await import("@/app/api/runs/[id]/status/route");
    const res = await GET(new Request("http://localhost/api/runs/run-1/status"), {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      run: { liveTokens: null },
    });
  });

  it("reports a null event cursor before the first run event", async () => {
    eventRows = [];
    installMocks();

    const { GET } = await import("@/app/api/runs/[id]/status/route");
    const res = await GET(new Request("http://localhost/api/runs/run-1/status"), {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { latestEventSequence: number | null };
    };
    expect(body.run.latestEventSequence).toBeNull();
  });

  it("audits an admin status poll against the run owner", async () => {
    currentSession = { ...session, id: "admin-uuid", role: "admin" };
    runRows = [
      {
        id: "run-1",
        userId: "target-user-uuid",
        status: "running",
        outputs: null,
        updatedAt: fixedDate,
      },
    ];
    installMocks();

    const { GET } = await import("@/app/api/runs/[id]/status/route");
    const request = new Request("http://localhost/api/runs/run-1/status", {
      headers: { "x-admin-access-justification": "Support case 42" },
    });
    const res = await GET(request, {
      params: Promise.resolve({ id: "run-1" }),
    });

    expect(res.status).toBe(200);
    expect(auditAdminDataAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: currentSession,
        access: {
          targetUserId: "target-user-uuid",
          resourceType: "run",
          resourceId: "run-1",
          surface: "run_status",
          justification: "Support case 42",
          runId: "run-1",
        },
      }),
    );
  });
});
