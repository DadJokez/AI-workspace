import { describe, expect, it } from "vitest";
import type { ToolApprovalRequest } from "@ai-workspace/agent";
import type { Database } from "@ai-workspace/db";
import { auditLog, runs, toolApprovalRequests } from "@ai-workspace/db";
import {
  decideToolApprovals,
  loadToolApprovalGrants,
  pauseRunForToolApprovals,
} from "@/lib/tool-approvals";

type Row = Record<string, unknown>;

interface FakeDbState {
  selectResults?: Row[][];
  insertResults?: Row[][];
  updateResults?: Row[][];
  inserts: Array<{ table: unknown; values: unknown }>;
  updates: Array<{ table: unknown; values: Row }>;
  transactionCount: number;
}

function fakeDb(overrides: Partial<FakeDbState> = {}) {
  const state: FakeDbState = {
    selectResults: [],
    insertResults: [],
    updateResults: [],
    inserts: [],
    updates: [],
    transactionCount: 0,
    ...overrides,
  };

  function resultChain(rows: Row[]) {
    const chain = Promise.resolve(rows) as Promise<Row[]> & {
      limit: () => ReturnType<typeof resultChain>;
      for: () => ReturnType<typeof resultChain>;
    };
    chain.limit = () => chain;
    chain.for = () => chain;
    return chain;
  }

  const db: Record<string, unknown> = {
    transaction: async <T>(callback: (tx: unknown) => Promise<T>) => {
      state.transactionCount += 1;
      return callback(db);
    },
    select: () => ({
      from: () => ({
        where: () => resultChain(state.selectResults?.shift() ?? []),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        state.inserts.push({ table, values });
        const promise = Promise.resolve(undefined);
        return Object.assign(promise, {
          returning: async () => state.insertResults?.shift() ?? [],
        });
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          state.updates.push({ table, values });
          const promise = Promise.resolve(undefined);
          return Object.assign(promise, {
            returning: async () => state.updateResults?.shift() ?? [],
          });
        },
      }),
    }),
  };

  return { db: db as unknown as Database, state };
}

function approvalRow(overrides: Row = {}) {
  const now = new Date("2026-08-15T12:00:00.000Z");
  return {
    id: "approval-1",
    batchId: "batch-1",
    runId: "run-1",
    userId: "user-1",
    threadId: "thread-1",
    toolCallId: "call-1",
    toolName: "gmail__draft_email",
    provider: "gmail",
    endpoint: "https://mcp.example.test",
    nativeToolName: "draft_email",
    callFingerprint: "a".repeat(64),
    redactedInput: { to: "person@example.test", body: "[REDACTED]" },
    status: "pending",
    requestedAt: now,
    decidedAt: null,
    decidedByUserId: null,
    consumedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("loadToolApprovalGrants", () => {
  it("atomically claims fresh decisions and marks only older receipts consumed", async () => {
    const consumedAt = new Date("2026-08-15T12:05:00.000Z");
    const { db, state } = fakeDb({
      selectResults: [
        [
          {
            id: "approval-fresh",
            toolCallId: "call-fresh",
            callFingerprint: "a".repeat(64),
            status: "approved",
            consumedAt: null,
          },
          {
            id: "approval-old",
            toolCallId: "call-old",
            callFingerprint: "b".repeat(64),
            status: "denied",
            consumedAt,
          },
        ],
      ],
    });

    const grants = await loadToolApprovalGrants({
      db,
      runId: "run-1",
      userId: "user-1",
      runOutputs: {
        approvalRequests: [{ id: "approval-fresh" }],
        toolResults: [
          { approvalId: "approval-old", output: { error: "denied" } },
        ],
      },
    });

    expect(state.transactionCount).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      table: toolApprovalRequests,
      values: { consumedAt: expect.any(Date), updatedAt: expect.any(Date) },
    });
    expect(grants).toEqual([
      {
        schema: "comparative.tool-approval-grant.v1",
        approvalId: "approval-fresh",
        toolCallId: "call-fresh",
        fingerprint: "a".repeat(64),
        decision: "approved",
      },
      {
        schema: "comparative.tool-approval-grant.v1",
        approvalId: "approval-old",
        toolCallId: "call-old",
        fingerprint: "b".repeat(64),
        decision: "denied",
        consumed: true,
        replayOutput: { error: "denied" },
      },
    ]);
  });

  it("does not touch the database for a run without approval state", async () => {
    const { db, state } = fakeDb();

    await expect(
      loadToolApprovalGrants({
        db,
        runId: "run-1",
        userId: "user-1",
        runOutputs: {},
      }),
    ).resolves.toEqual([]);
    expect(state.transactionCount).toBe(0);
  });
});

describe("pauseRunForToolApprovals", () => {
  it("persists only the redacted call input and releases the worker lease", async () => {
    const row = approvalRow();
    const { db, state } = fakeDb({
      insertResults: [[row]],
      updateResults: [[{ id: "run-1" }]],
    });
    const request: ToolApprovalRequest = {
      schema: "comparative.tool-approval-request.v1",
      toolCallId: "call-1",
      toolName: "gmail__draft_email",
      fingerprint: "a".repeat(64),
      identity: {
        kind: "mcp",
        provider: "gmail",
        endpoint: "https://mcp.example.test",
        nativeToolName: "draft_email",
      },
    };

    const approvals = await pauseRunForToolApprovals({
      db,
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      requests: [request],
      calls: [
        {
          id: "call-1",
          name: "gmail__draft_email",
          input: { body: "[REDACTED]" },
          provider: "gmail",
          toolName: "draft_email",
          startedAt: "2026-08-15T12:00:00.000Z",
        },
      ],
      outputs: { assistantText: "I need permission." },
      expectedWorkerId: "worker-1",
    });

    const inserted = state.inserts.find(
      (entry) => entry.table === toolApprovalRequests,
    );
    expect(inserted?.values).toEqual([
      expect.objectContaining({
        runId: "run-1",
        toolCallId: "call-1",
        redactedInput: { body: "[REDACTED]" },
      }),
    ]);
    expect(JSON.stringify(inserted?.values)).not.toContain("secret body");
    expect(state.updates.find((entry) => entry.table === runs)?.values).toMatchObject(
      {
        status: "waiting_for_approval",
        workerId: null,
        leaseExpiresAt: null,
        outputs: expect.objectContaining({
          lifecycle: "waiting_for_approval",
          approvalRequests: approvals,
        }),
      },
    );
  });

  it("stores a changed fingerprint even when the model reuses its tool call id", async () => {
    const row = approvalRow({
      id: "approval-changed",
      callFingerprint: "c".repeat(64),
    });
    const { db, state } = fakeDb({
      insertResults: [[row]],
      updateResults: [[{ id: "run-1" }]],
    });

    await pauseRunForToolApprovals({
      db,
      runId: "run-1",
      userId: "user-1",
      threadId: "thread-1",
      requests: [
        {
          schema: "comparative.tool-approval-request.v1",
          toolCallId: "call-1",
          toolName: "gmail__draft_email",
          fingerprint: "c".repeat(64),
        },
      ],
      calls: [
        {
          id: "call-1",
          name: "gmail__draft_email",
          input: { subject: "Changed subject" },
          provider: "gmail",
          toolName: "draft_email",
          startedAt: "2026-08-15T12:00:00.000Z",
        },
      ],
      outputs: {},
    });

    expect(state.inserts[0]?.values).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        callFingerprint: "c".repeat(64),
      }),
    ]);
  });
});

describe("decideToolApprovals", () => {
  it("audits the owner decision and queues the run after the final approval", async () => {
    const pending = approvalRow();
    const approved = approvalRow({
      status: "approved",
      decidedAt: new Date("2026-08-15T12:10:00.000Z"),
      decidedByUserId: "user-1",
    });
    const { db, state } = fakeDb({
      selectResults: [
        [
          {
            id: "run-1",
            userId: "user-1",
            status: "waiting_for_approval",
            outputs: { lifecycle: "waiting_for_approval" },
          },
        ],
        [pending],
        [approved],
      ],
    });

    const result = await decideToolApprovals({
      db,
      runId: "run-1",
      userId: "user-1",
      approvalIds: ["approval-1"],
      decision: "approve",
    });

    expect(result).toMatchObject({ ok: true, queued: true });
    expect(state.inserts.find((entry) => entry.table === auditLog)?.values).toEqual([
      expect.objectContaining({
        actorUserId: "user-1",
        actionType: "tool_approval_decision",
        status: "succeeded",
        policyDecision: "approved_by_user",
      }),
    ]);
    expect(state.updates.find((entry) => entry.table === runs)?.values).toMatchObject(
      {
        status: "queued",
        workerId: null,
        leaseExpiresAt: null,
        outputs: expect.objectContaining({ lifecycle: "approval_decided" }),
      },
    );
  });

  it("rejects stale or foreign approval ids without changing the run", async () => {
    const { db, state } = fakeDb({
      selectResults: [
        [
          {
            id: "run-1",
            userId: "user-1",
            status: "waiting_for_approval",
            outputs: {},
          },
        ],
        [],
      ],
    });

    const result = await decideToolApprovals({
      db,
      runId: "run-1",
      userId: "user-1",
      approvalIds: ["approval-foreign"],
      decision: "deny",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "approval_not_pending",
    });
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });
});
