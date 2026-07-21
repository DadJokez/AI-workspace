import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Run } from "@ai-workspace/db";
import type { SessionUser } from "@ai-workspace/auth";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * The run-lifecycle control surface (#443): 310 previously-untested lines with
 * ownership checks. Covered here: the legal-transition matrix for
 * cancel/retry/resume across every run status, the ownership predicate itself
 * (rendered SQL — a mocked db otherwise discards the WHERE clause), the
 * unsupported-run-type guard, and retry's stored-context requirements.
 */

vi.mock("@/lib/run-events", () => ({
  appendRunEventWithNextSequence: vi.fn(async () => undefined),
}));
vi.mock("@/lib/chat-run-worker", () => ({
  startInProcessChatRunWorker: vi.fn(),
}));

import { cancelRun, resumeChatRun, retryChatRun } from "@/lib/run-actions";
import { appendRunEventWithNextSequence } from "@/lib/run-events";
import { startInProcessChatRunWorker } from "@/lib/chat-run-worker";

const owner: SessionUser = {
  id: "user-owner",
  email: "owner@example.com",
  displayName: "Owner",
  role: "user",
} as SessionUser;
const stranger: SessionUser = {
  id: "user-stranger",
  email: "stranger@example.com",
  displayName: "Stranger",
  role: "user",
} as SessionUser;
const admin: SessionUser = {
  id: "user-admin",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
} as SessionUser;

function chatRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    userId: owner.id,
    threadId: "thread-1",
    skillId: null,
    skillSlug: "chat-turn",
    scheduleId: null,
    eventTriggerId: null,
    triggerType: "chat",
    status: "running",
    modelId: "sonnet-4-6",
    inputs: {
      prompt: "original prompt",
      threadId: "thread-1",
      userMessageId: "msg-1",
    },
    error: null,
    ...overrides,
  } as Run;
}

/**
 * Chainable fake for the Drizzle query builder (same pattern as
 * notifications.test.ts): select results resolve in call order; update `set`
 * values, insert `values`, and the select WHERE condition are captured so the
 * scope predicate and state writes can be asserted.
 */
function fakeDb(selectResults: Array<Run[]>) {
  const captured: {
    selectWheres: SQL[];
    updateSets: Array<Record<string, unknown>>;
    inserts: Array<{ values: Record<string, unknown> }>;
  } = { selectWheres: [], updateSets: [], inserts: [] };

  const db = {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          captured.selectWheres.push(condition);
          const pending = Promise.resolve(selectResults.shift() ?? []);
          return Object.assign(pending, { limit: () => pending });
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          captured.updateSets.push(values);
          const pending = Promise.resolve(undefined);
          return Object.assign(pending, {
            returning: async () => [
              { id: "run-1", status: values.status ?? "running" },
            ],
          });
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        captured.inserts.push({ values });
        const pending = Promise.resolve(undefined);
        return Object.assign(pending, {
          returning: async () => [
            { id: "run-new", status: values.status ?? "queued" },
          ],
        });
      },
    }),
  } as unknown as Database;

  return { db, captured };
}

function renderCondition(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ownership scoping", () => {
  it.each([
    ["cancelRun", cancelRun],
    ["retryChatRun", retryChatRun],
    ["resumeChatRun", resumeChatRun],
  ] as const)(
    "%s scopes the lookup to the actor's own runs and 404s when nothing matches",
    async (_name, action) => {
      const { db, captured } = fakeDb([[]]);
      const result = await action({ db, actor: stranger, runId: "run-1" });

      expect(result).toMatchObject({ ok: false, status: 404, error: "run_not_found" });
      // The predicate itself: run id AND owner id for a non-admin actor.
      const query = renderCondition(captured.selectWheres[0]!);
      expect(query.sql).toContain('"id" =');
      expect(query.sql).toContain('"user_id" =');
      expect(query.params).toEqual(["run-1", stranger.id]);
      // A denied action leaves no side effects behind.
      expect(captured.updateSets).toEqual([]);
      expect(captured.inserts).toEqual([]);
      expect(vi.mocked(appendRunEventWithNextSequence)).not.toHaveBeenCalled();
      expect(vi.mocked(startInProcessChatRunWorker)).not.toHaveBeenCalled();
    },
  );

  it("admin lookups drop the owner filter (intentional admin visibility)", async () => {
    const { db, captured } = fakeDb([[chatRun({ status: "queued" })]]);
    const result = await cancelRun({ db, actor: admin, runId: "run-1" });

    expect(result).toMatchObject({ ok: true });
    const query = renderCondition(captured.selectWheres[0]!);
    expect(query.sql).toContain('"id" =');
    expect(query.sql).not.toContain('"user_id"');
    expect(query.params).toEqual(["run-1"]);
  });
});

describe("legal-transition matrix", () => {
  const statuses = ["queued", "running", "succeeded", "failed", "canceled"] as const;

  it.each(statuses)("cancelRun from %s", async (status) => {
    const { db, captured } = fakeDb([[chatRun({ status })]]);
    const result = await cancelRun({ db, actor: owner, runId: "run-1" });

    if (status === "queued" || status === "running") {
      expect(result).toMatchObject({ ok: true, run: { status: "canceled" } });
      expect(captured.updateSets[0]).toMatchObject({
        status: "canceled",
        workerId: null,
        leaseExpiresAt: null,
      });
      expect(vi.mocked(appendRunEventWithNextSequence)).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "run_canceled" }),
      );
      expect(captured.inserts[0]?.values).toMatchObject({
        actionType: "run_cancel",
        actorUserId: owner.id,
      });
    } else {
      expect(result).toMatchObject({
        ok: false,
        status: 409,
        error: "run_not_cancelable",
      });
      expect(captured.updateSets).toEqual([]);
    }
  });

  it.each(statuses)("retryChatRun from %s", async (status) => {
    const { db, captured } = fakeDb([[chatRun({ status })]]);
    const result = await retryChatRun({ db, actor: owner, runId: "run-1" });

    if (status === "failed" || status === "canceled") {
      expect(result).toMatchObject({ ok: true, run: { id: "run-new" } });
      // The retry is a NEW queued run pointing back at its source.
      expect(captured.inserts[0]?.values).toMatchObject({
        status: "queued",
        triggerType: "chat_retry",
        userId: owner.id,
        inputs: expect.objectContaining({
          prompt: "original prompt",
          retryOfRunId: "run-1",
          retryOfStatus: status,
          retryRequestedByUserId: owner.id,
        }),
      });
      expect(vi.mocked(startInProcessChatRunWorker)).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-new" }),
      );
    } else {
      expect(result).toMatchObject({
        ok: false,
        status: 409,
        error: "run_not_retryable",
      });
      expect(captured.inserts).toEqual([]);
      expect(vi.mocked(startInProcessChatRunWorker)).not.toHaveBeenCalled();
    }
  });

  it.each(statuses)("resumeChatRun from %s", async (status) => {
    const { db, captured } = fakeDb([[chatRun({ status })]]);
    const result = await resumeChatRun({ db, actor: owner, runId: "run-1" });

    if (status === "queued" || status === "running") {
      expect(result).toMatchObject({ ok: true, run: { id: "run-1", status } });
      // Resume = expire the lease so a worker can reclaim immediately.
      expect(captured.updateSets[0]).toMatchObject({
        leaseExpiresAt: new Date(0),
      });
      expect(vi.mocked(startInProcessChatRunWorker)).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1" }),
      );
    } else {
      expect(result).toMatchObject({
        ok: false,
        status: 409,
        error: "run_not_resumable",
      });
      expect(captured.updateSets).toEqual([]);
      expect(vi.mocked(startInProcessChatRunWorker)).not.toHaveBeenCalled();
    }
  });
});

describe("run-type and retry-context guards", () => {
  const nonWorkerRun = () =>
    chatRun({ skillSlug: "developer-briefing", triggerType: "manual" as Run["triggerType"] });

  it.each([
    ["cancelRun", cancelRun, "queued"],
    ["retryChatRun", retryChatRun, "failed"],
    ["resumeChatRun", resumeChatRun, "queued"],
  ] as const)("%s rejects a non worker-executable run with 400", async (_name, action, status) => {
    const { db, captured } = fakeDb([
      [nonWorkerRun()].map((run) => ({ ...run, status: status as Run["status"] })),
    ]);
    const result = await action({ db, actor: owner, runId: "run-1" });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "unsupported_run_type",
    });
    expect(captured.updateSets).toEqual([]);
    expect(captured.inserts).toEqual([]);
  });

  it("skill runs retry as skill_retry, not chat_retry", async () => {
    const { db, captured } = fakeDb([
      [
        chatRun({
          status: "failed",
          skillSlug: "weekly-report",
          triggerType: "skill",
        }),
      ],
    ]);
    const result = await retryChatRun({ db, actor: owner, runId: "run-1" });

    expect(result).toMatchObject({ ok: true });
    expect(captured.inserts[0]?.values).toMatchObject({
      triggerType: "skill_retry",
    });
  });

  it("retryChatRun refuses a run whose stored inputs cannot reconstruct the turn", async () => {
    const { db, captured } = fakeDb([
      [chatRun({ status: "failed", inputs: { prompt: "only a prompt" } })],
    ]);
    const result = await retryChatRun({ db, actor: owner, runId: "run-1" });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "missing_retry_context",
    });
    expect(captured.inserts).toEqual([]);
    expect(vi.mocked(startInProcessChatRunWorker)).not.toHaveBeenCalled();
  });

  it("retryChatRun refuses non-object stored inputs", async () => {
    const { db } = fakeDb([
      [chatRun({ status: "failed", inputs: "corrupted" as unknown as Run["inputs"] })],
    ]);
    const result = await retryChatRun({ db, actor: owner, runId: "run-1" });
    expect(result).toMatchObject({ ok: false, error: "missing_retry_context" });
  });
});
