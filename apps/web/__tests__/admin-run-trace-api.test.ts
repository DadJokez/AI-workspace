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
  recentTraceRows: Array<Record<string, unknown>>;
  recentAccessRows: Array<Record<string, unknown>>;
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

    function select(selection?: Record<string, unknown>) {
      let table: unknown;
      let ordered = false;
      const recentKind =
        selection && "metadata" in selection ? "admin" : "trace";
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
            if (ordered) return Promise.resolve(fixtures.auditRows);
            return Promise.resolve(
              recentKind === "admin"
                ? fixtures.recentAccessRows
                : fixtures.recentTraceRows,
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
          values: async (
            value:
              | Record<string, unknown>
              | Array<Record<string, unknown>>,
          ) => {
            fixtures.insertedAudit.push(
              ...(Array.isArray(value) ? value : [value]),
            );
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
        outputs: {
          assistantText: "Done.",
          metrics: {
            firstTokenAt: "2026-07-15T01:00:01.250Z",
            requestToFirstTokenMs: 1250,
            providerToFirstTokenMs: 900,
          },
        },
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
        id: "event-snapshot-uuid",
        sequence: 0,
        eventType: "provider_context_snapshot",
        status: "succeeded",
        label: "Captured 2 provider request snapshots",
        provider: "bedrock",
        toolName: null,
        toolCallId: null,
        input: null,
        // v2 deduplicated payload (#386): the route must expand it back to
        // the per-request timeline before serving.
        output: {
          shared: {
            tools: {
              toolhash1: [{ name: "github_search", description: "Search." }],
            },
            systemPrompts: { prompthash1: "You are the harness." },
            messages: [
              { role: "user", content: [{ kind: "text", text: "start" }] },
              { role: "assistant", content: [{ kind: "text", text: "step" }] },
            ],
          },
          requests: [
            {
              iteration: 0,
              providerModelId: "us.anthropic.claude-sonnet-4-6",
              requestHash: "r1",
              systemPromptHash: "prompthash1",
              messagesHash: "m1",
              toolsHash: "toolhash1",
              messagesCount: 1,
              request: { providerModelId: "us.anthropic.claude-sonnet-4-6" },
            },
            {
              iteration: 1,
              providerModelId: "us.anthropic.claude-sonnet-4-6",
              requestHash: "r2",
              systemPromptHash: "prompthash1",
              messagesHash: "m2",
              toolsHash: "toolhash1",
              messagesCount: 2,
              request: { providerModelId: "us.anthropic.claude-sonnet-4-6" },
            },
          ],
        },
        error: null,
        metadata: { schema: "run-trace.v2", schemaVersion: 2 },
        occurredAt: new Date("2026-07-15T01:00:00.500Z"),
      },
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
    recentTraceRows: [],
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
      expect.objectContaining({
        actorUserId: adminSession.id,
        runId: "run-uuid",
        actionType: "admin_data_access",
        status: "succeeded",
        metadata: {
          schema: "admin-data-access.v1",
          targetUserId: "user-uuid",
          resourceType: "run",
          resourceId: "run-uuid",
          surface: "run_inspector",
        },
      }),
    ]);
  });

  it("preserves first-token timing telemetry through the export while credentials stay redacted (#387)", async () => {
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
    // Timing observability survives persistence → read-time redaction →
    // serialization with types intact…
    expect(serialized).toContain('"firstTokenAt":"2026-07-15T01:00:01.250Z"');
    expect(serialized).toContain('"requestToFirstTokenMs":1250');
    expect(serialized).toContain('"providerToFirstTokenMs":900');
    // …while credential material in the same trace does not.
    expect(serialized).not.toContain("should-not-leak");
  });

  it("preserves AgentCore authorization diagnostics for admin investigation (#572)", async () => {
    const deniedAction = "bedrock-agentcore:InvokeAgentRuntimeForUser";
    const deniedResource =
      "arn:aws:bedrock-agentcore:us-east-1:351478076796:runtime/comparative";
    fixtures.runRows[0]!.outputs = {
      requestedModelId: "sonnet-4-6",
      modelId: "sonnet-4-6",
      runtimeTarget: "agentcore-worker",
      errorDetails: [
        {
          code: "agentcore_invoke_access_denied",
          category: "runtime_authorization_denied",
          rawMessage: `AccessDeniedException: not authorized to perform ${deniedAction} on resource: ${deniedResource}`,
          metadata: {
            runtime: "agentcore",
            runtimeTarget: "agentcore-worker",
            requestedModelId: "sonnet-4-6",
            modelId: "sonnet-4-6",
            deniedAction,
            deniedResource,
          },
        },
      ],
    };
    setAdminResult("admin");
    installDbMock();
    const { GET } = await import("@/app/api/admin/runs/[id]/trace/route");

    const response = await GET(
      new Request("http://localhost/api/admin/runs/run-uuid/trace"),
      { params: Promise.resolve({ id: "run-uuid" }) },
    );
    const body = (await response.json()) as {
      trace: { run: { outputs: Record<string, unknown> } };
    };
    const serialized = JSON.stringify(body.trace.run.outputs);

    expect(response.status).toBe(200);
    expect(serialized).toContain("runtime_authorization_denied");
    expect(serialized).toContain(deniedAction);
    expect(serialized).toContain(deniedResource);
    expect(serialized).toContain('"runtimeTarget":"agentcore-worker"');
    expect(serialized).toContain('"requestedModelId":"sonnet-4-6"');
  });

  it("serves v2 snapshots as the reconstructed per-request timeline (#386)", async () => {
    setAdminResult("admin");
    installDbMock();
    const { GET } = await import("@/app/api/admin/runs/[id]/trace/route");

    const response = await GET(
      new Request("http://localhost/api/admin/runs/run-uuid/trace"),
      { params: Promise.resolve({ id: "run-uuid" }) },
    );
    const body = (await response.json()) as {
      trace: { events: Array<Record<string, unknown>> };
    };
    const snapshot = body.trace.events.find(
      (event) => event.eventType === "provider_context_snapshot",
    );
    expect(snapshot).toBeDefined();
    const output = snapshot!.output as {
      requests: Array<{ request: Record<string, unknown> }>;
      shared?: unknown;
    };
    // Expanded: every request carries its own tools/systemPrompt/messages
    // again, and the deduplicated shared section is gone from the wire.
    expect(output.shared).toBeUndefined();
    expect(output.requests).toHaveLength(2);
    expect(output.requests[0]!.request.tools).toEqual([
      { name: "github_search", description: "Search." },
    ]);
    expect(output.requests[0]!.request.systemPrompt).toBe(
      "You are the harness.",
    );
    expect(
      (output.requests[0]!.request.messages as unknown[]).length,
    ).toBe(1);
    expect(
      (output.requests[1]!.request.messages as unknown[]).length,
    ).toBe(2);
  });

  it("deduplicates polling access within the audit window", async () => {
    fixtures.recentTraceRows = [{ id: "existing-trace-access" }];
    fixtures.recentAccessRows = [
      {
        metadata: {
          schema: "admin-data-access.v1",
          targetUserId: "user-uuid",
          resourceType: "run",
          resourceId: "run-uuid",
          surface: "run_inspector",
        },
      },
    ];
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

  it("does not label an admin's own run as privileged cross-user access", async () => {
    fixtures.runRows[0]!.userId = adminSession.id;
    setAdminResult("admin");
    installDbMock();
    const { GET } = await import("@/app/api/admin/runs/[id]/trace/route");

    const response = await GET(
      new Request("http://localhost/api/admin/runs/run-uuid/trace"),
      { params: Promise.resolve({ id: "run-uuid" }) },
    );

    expect(response.status).toBe(200);
    expect(fixtures.insertedAudit).toEqual([
      expect.objectContaining({
        actorUserId: adminSession.id,
        runId: "run-uuid",
        actionType: "run_trace_viewed",
        status: "succeeded",
      }),
    ]);
  });

  it("preserves the endpoint event and audit limits after read-time redaction", async () => {
    fixtures.eventRows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `event-${index}`,
      sequence: index + 1,
      eventType: "provider_event",
      status: "succeeded",
      label: `Provider event ${index + 1}`,
      provider: "bedrock",
      toolName: null,
      toolCallId: null,
      input: null,
      output: { index },
      error: null,
      metadata: null,
      occurredAt: new Date(
        `2026-07-15T01:00:${String(index % 60).padStart(2, "0")}.000Z`,
      ),
    }));
    fixtures.auditRows = Array.from({ length: 250 }, (_, index) => ({
      id: `audit-${index}`,
      actionType: "tool_invoked",
      status: "succeeded",
      provider: "github",
      toolName: "github_search",
      toolCallId: `call-${index}`,
      input: { query: `query-${index}` },
      output: { count: index },
      error: null,
      metadata: null,
      startedAt: new Date("2026-07-15T01:00:00.000Z"),
      completedAt: new Date("2026-07-15T01:00:01.000Z"),
      createdAt: new Date("2026-07-15T01:00:01.000Z"),
    }));
    setAdminResult("admin");
    installDbMock();
    const { GET } = await import("@/app/api/admin/runs/[id]/trace/route");

    const response = await GET(
      new Request("http://localhost/api/admin/runs/run-uuid/trace"),
      { params: Promise.resolve({ id: "run-uuid" }) },
    );
    const body = (await response.json()) as {
      trace: { events: unknown[]; auditEvents: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.trace.events).toHaveLength(1_000);
    expect(body.trace.auditEvents).toHaveLength(250);
  });
});
