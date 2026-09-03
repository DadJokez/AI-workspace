import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireSession,
  decideToolApprovals,
  appendRunEventBestEffort,
  startInProcessChatRunWorker,
} = vi.hoisted(() => ({
  requireSession: vi.fn(),
  decideToolApprovals: vi.fn(),
  appendRunEventBestEffort: vi.fn(async () => undefined),
  startInProcessChatRunWorker: vi.fn(),
}));

vi.mock("@/lib/auth/requireSession", () => ({ requireSession }));
vi.mock("@/lib/tool-approvals", () => ({ decideToolApprovals }));
vi.mock("@/lib/run-events", () => ({ appendRunEventBestEffort }));
vi.mock("@/lib/chat-run-worker", () => ({ startInProcessChatRunWorker }));
vi.mock("@ai-workspace/db", () => ({ getDb: () => ({}) }));
vi.mock("@ai-workspace/auth", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { POST } from "@/app/api/runs/[id]/tool-approvals/route";

const approvalId = "00000000-0000-4000-8000-000000000001";
const requestRow = {
  id: approvalId,
  batchId: "00000000-0000-4000-8000-000000000002",
  toolCallId: "call-1",
  toolName: "mcp__google__draft_email",
  provider: "google",
  nativeToolName: "draft_email",
  redactedInput: { to: "[REDACTED]" },
  status: "approved",
  requestedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2026-08-16T00:00:00.000Z",
  decidedAt: "2026-08-15T00:01:00.000Z",
};

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/runs/run-1/tool-approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "run-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ user: { id: "user-1", role: "user" } });
});

describe("POST /api/runs/[id]/tool-approvals", () => {
  it("saves an approval and starts the queued run", async () => {
    decideToolApprovals.mockResolvedValue({
      ok: true,
      queued: true,
      approvals: [requestRow],
      decided: [requestRow],
    });

    const response = await post({
      decision: "approve",
      approvalIds: [approvalId],
      rememberForSkill: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: { id: "run-1", status: "queued" },
    });
    expect(decideToolApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        userId: "user-1",
        decision: "approve",
        approvalIds: [approvalId],
        rememberForSkill: true,
      }),
    );
    expect(startInProcessChatRunWorker).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1" }),
    );
    expect(appendRunEventBestEffort).toHaveBeenCalledWith(
      "tool-approval-event-error",
      expect.objectContaining({ eventType: "tool_approval_decided" }),
    );
  });

  it("rejects invalid and duplicate approval IDs before touching the DB", async () => {
    const invalid = await post({ decision: "approve", approvalIds: ["nope"] });
    const duplicate = await post({
      decision: "deny",
      approvalIds: [approvalId, approvalId],
    });

    expect(invalid.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(decideToolApprovals).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean remembered approval flag", async () => {
    const response = await post({
      decision: "approve",
      approvalIds: [approvalId],
      rememberForSkill: "yes",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_remember_for_skill",
    });
    expect(decideToolApprovals).not.toHaveBeenCalled();
  });

  it("does not start a worker while another request in the batch is pending", async () => {
    decideToolApprovals.mockResolvedValue({
      ok: true,
      queued: false,
      approvals: [{ ...requestRow, status: "approved" }],
      decided: [requestRow],
    });

    const response = await post({
      decision: "approve",
      approvalIds: [approvalId],
      rememberForSkill: false,
    });

    expect(response.status).toBe(200);
    expect(startInProcessChatRunWorker).not.toHaveBeenCalled();
  });
});
