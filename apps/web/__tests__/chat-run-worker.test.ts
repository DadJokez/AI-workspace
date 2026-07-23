import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Run } from "@ai-workspace/db";
import { chatThreads } from "@ai-workspace/db";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * #442 — the worker lane is now a thin shell around the shared
 * executeChatTurn core. These tests pin the shell's own responsibilities:
 * claiming, turn-time model re-validation (the fork had let the worker
 * trust a stale run.modelId verbatim), and the lane configuration it hands
 * to the core.
 */

vi.mock("@/lib/execute-chat-turn", () => ({
  executeChatTurn: vi.fn(async () => undefined),
  isRunCanceled: vi.fn(async () => false),
  numberFromEnv: vi.fn(() => undefined),
}));
vi.mock("@ai-workspace/agent-runtime", () => ({
  getRuntime: vi.fn(() => ({ name: "bedrock" })),
}));
vi.mock("@/lib/model-registry", () => ({
  resolveModelForPurpose: vi.fn(async () => "haiku-4-5"),
}));
vi.mock("@/lib/run-events", () => ({
  appendRunEventBestEffort: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications", () => ({
  createProactiveRunNotification: vi.fn(async () => undefined),
}));

import {
  heartbeatRunLease,
  processQueuedChatRun,
  reapOrphanedRuns,
  runChatRunWorkerLoop,
} from "@/lib/chat-run-worker";
import { executeChatTurn, numberFromEnv } from "@/lib/execute-chat-turn";
import { resolveModelForPurpose } from "@/lib/model-registry";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { createProactiveRunNotification } from "@/lib/notifications";

function claimedRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    userId: "user-1",
    threadId: "thread-1",
    triggerType: "skill",
    skillSlug: "daily-briefing",
    modelId: "sonnet-4-6",
    inputs: {
      prompt: "run the briefing",
      threadId: "thread-1",
      userMessageId: "user-msg-1",
      executionMode: "local",
      requestedProviders: ["github"],
    },
    outputs: null,
    ...overrides,
  } as unknown as Run;
}

function fakeDb(run: Run): Database {
  return {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [run],
        }),
      }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === chatThreads ? [{ id: "thread-1", summary: null }] : [],
        }),
      }),
    }),
  } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processQueuedChatRun", () => {
  it("re-validates the stored model against the registry at turn time (#442 drift fix)", async () => {
    const run = claimedRun();
    const db = fakeDb(run);

    const result = await processQueuedChatRun({ db, runId: "run-1" });

    expect(result).toEqual({ status: "succeeded", runId: "run-1" });
    // Legacy worker runs without a stored route run on the durable lane.
    expect(resolveModelForPurpose).toHaveBeenCalledWith(db, "durable-local", {
      preferred: "sonnet-4-6",
    });
    expect(executeChatTurn).toHaveBeenCalledTimes(1);
    const turn = vi.mocked(executeChatTurn).mock.calls[0]![0];
    expect(turn.modelId).toBe("haiku-4-5");
  });

  it("hands the core the worker lane configuration", async () => {
    const run = claimedRun();
    const db = fakeDb(run);

    await processQueuedChatRun({ db, runId: "run-1", workerId: "w-test" });

    const turn = vi.mocked(executeChatTurn).mock.calls[0]![0];
    expect(turn.userId).toBe("user-1");
    expect(turn.prompt).toBe("run the briefing");
    expect(turn.userMessageId).toBe("user-msg-1");
    expect(turn.requestedProviders).toEqual(["github"]);
    // Skill runs are not interactive turns.
    expect(turn.interactive).toBe(false);
    expect(turn.lane).toMatchObject({
      kind: "worker",
      run,
      workerId: "w-test",
      executionMode: "local",
      preferArtifactFallback: true,
      storedArtifactTarget: null,
      storedSeparateFromArtifact: null,
    });
  });

  it("treats chat-trigger runs as interactive and skips artifact fallback", async () => {
    const run = claimedRun({ triggerType: "chat" } as Partial<Run>);
    const db = fakeDb(run);

    await processQueuedChatRun({ db, runId: "run-1" });

    const turn = vi.mocked(executeChatTurn).mock.calls[0]![0];
    expect(turn.interactive).toBe(true);
    expect(turn.lane).toMatchObject({
      kind: "worker",
      preferArtifactFallback: false,
    });
  });

  it("hands a stored chat-turn timezone to the core so retries keep the clock context (#432)", async () => {
    const run = claimedRun({
      triggerType: "chat",
      inputs: {
        prompt: "what should I do tomorrow?",
        threadId: "thread-1",
        userMessageId: "user-msg-1",
        executionMode: "local",
        userTimeZone: "America/New_York",
      },
    } as Partial<Run>);

    await processQueuedChatRun({ db: fakeDb(run), runId: "run-1" });

    const turn = vi.mocked(executeChatTurn).mock.calls[0]![0];
    expect(turn.userTimeZone).toBe("America/New_York");
  });

  it("preserves the durable resource receipt across worker retries and resumes (#576)", async () => {
    const resourceResolution = {
      version: 1,
      status: "selected",
      intent: true,
      selected: [
        {
          resourceId: "resource-report",
          filename: "report.csv",
          mimeType: "text/csv",
          kind: "spreadsheet",
          sizeBytes: 7_800_000,
          representation: "tabular_dataset",
          coverage: "full",
          reason: "previous_run_receipt",
        },
      ],
      candidates: [
        {
          resourceId: "resource-report",
          filename: "report.csv",
          kind: "spreadsheet",
        },
      ],
      requiresCompleteFileTool: true,
    };
    const run = claimedRun({
      triggerType: "chat",
      inputs: {
        prompt: "continue analyzing it",
        threadId: "thread-1",
        userMessageId: "user-msg-1",
        executionMode: "local",
        resourceResolution,
      },
    } as Partial<Run>);

    await processQueuedChatRun({ db: fakeDb(run), runId: "run-1" });

    expect(vi.mocked(executeChatTurn).mock.calls[0]![0]).toMatchObject({
      resourceResolution,
    });
  });

  it("re-validates the stored timezone and drops anything that is not an IANA zone (#432)", async () => {
    const run = claimedRun({
      triggerType: "chat",
      inputs: {
        prompt: "hi",
        threadId: "thread-1",
        userMessageId: "user-msg-1",
        executionMode: "local",
        userTimeZone: "'; DROP TABLE runs;--",
      },
    } as Partial<Run>);

    await processQueuedChatRun({ db: fakeDb(run), runId: "run-1" });

    const turn = vi.mocked(executeChatTurn).mock.calls[0]![0];
    expect(turn.userTimeZone).toBeUndefined();
  });

  it("leaves scheduled/skill runs without a timezone UTC-only (#432)", async () => {
    const run = claimedRun({ triggerType: "scheduled" } as Partial<Run>);

    await processQueuedChatRun({ db: fakeDb(run), runId: "run-1" });

    const turn = vi.mocked(executeChatTurn).mock.calls[0]![0];
    expect(turn.userTimeZone).toBeUndefined();
  });

  it("reports the lease as lost when the fenced heartbeat matches no row (#443)", async () => {
    const emptyDb = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [] }),
        }),
      }),
    } as unknown as Database;
    await expect(heartbeatRunLease(emptyDb, "run-1", "w-test")).resolves.toBe(
      false,
    );

    const heldDb = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: "run-1" }] }),
        }),
      }),
    } as unknown as Database;
    await expect(heartbeatRunLease(heldDb, "run-1", "w-test")).resolves.toBe(
      true,
    );
  });

  it("reaps leaseless runs with dead heartbeats and notifies (#443)", async () => {
    const orphan = claimedRun({ triggerType: "chat" } as Partial<Run>);
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => [{ ...orphan, error: values.error }],
          }),
        }),
      }),
    } as unknown as Database;

    const reaped = await reapOrphanedRuns({ db });

    expect(reaped).toBe(1);
    expect(appendRunEventBestEffort).toHaveBeenCalledWith(
      "chat-run-event-error",
      expect.objectContaining({
        runId: "run-1",
        eventType: "run_failed",
        status: "failed",
      }),
    );
    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "run-1" }),
      "failed",
      "thread-1",
    );
  });

  it("scopes the reaper to the chat lane so other inline runs are never reaped (#443 review)", async () => {
    // The developer-briefing lane also inserts `running` runs with no lease
    // and no heartbeat; the reaper must not reach them. Render the real query
    // predicate and assert it is bound to skill_slug = 'chat-turn'.
    let captured: unknown;
    const db = {
      update: () => ({
        set: () => ({
          where: (condition: unknown) => {
            captured = condition;
            return { returning: async () => [] };
          },
        }),
      }),
    } as unknown as Database;

    await reapOrphanedRuns({ db });

    const { sql, params } = new PgDialect().sqlToQuery(captured as never);
    expect(sql).toContain("skill_slug");
    expect(params).toContain("chat-turn");
    // A non-chat orphan shape (null lease, stale updatedAt) is excluded by
    // that predicate, so no row is returned and nothing is notified.
    expect(createProactiveRunNotification).not.toHaveBeenCalled();
  });

  it("marks the run failed when the core throws", async () => {
    const run = claimedRun();
    const db = fakeDb(run);
    vi.mocked(executeChatTurn).mockRejectedValueOnce(new Error("boom"));

    const result = await processQueuedChatRun({ db, runId: "run-1" });

    expect(result).toEqual({ status: "failed", runId: "run-1" });
    const { createProactiveRunNotification } = await import(
      "@/lib/notifications"
    );
    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "run-1", error: "boom" }),
      "failed",
    );
  });
});

/**
 * #448 — the loop claims and executes up to WORKER_RUN_CONCURRENCY runs at
 * once. Claims stay sequential; executions overlap; every in-flight run keeps
 * heartbeating its own fenced lease.
 */
describe("runChatRunWorkerLoop concurrency (#448)", () => {
  function loopDb(queuedRuns: Run[]) {
    const state = {
      queued: [...queuedRuns],
      claims: [] as string[],
      heartbeats: [] as unknown[][],
    };
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: unknown) => ({
            returning: async () => {
              if (values.status === "running") {
                const { params } = new PgDialect().sqlToQuery(
                  condition as never,
                );
                const run = state.queued.find((r) => params.includes(r.id));
                if (!run) return [];
                state.queued = state.queued.filter((r) => r.id !== run.id);
                state.claims.push(run.id);
                return [run];
              }
              // Reaper / markRunFailed writes: nothing to reap or fail.
              if (values.status !== undefined) return [];
              // Fenced lease heartbeat (no status in the set clause).
              const { params } = new PgDialect().sqlToQuery(condition as never);
              state.heartbeats.push(params);
              return [{ id: "held" }];
            },
          }),
        }),
      }),
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => ({
              limit: async () =>
                state.queued[0] ? [{ id: state.queued[0].id }] : [],
            }),
            limit: async () =>
              table === chatThreads ? [{ id: "thread-1", summary: null }] : [],
          }),
        }),
      }),
    } as unknown as Database;
    return { db, state };
  }

  const queuedRun = (id: string) => claimedRun({ id } as Partial<Run>);

  function deferredTurns() {
    const resolvers = new Map<string, () => void>();
    vi.mocked(executeChatTurn).mockImplementation(
      (input: { runId: string }) =>
        new Promise((resolve) => {
          resolvers.set(input.runId, () => resolve(undefined));
        }) as never,
    );
    return resolvers;
  }

  it("caps in-flight runs and keeps claiming while a slow run executes", async () => {
    vi.mocked(numberFromEnv).mockImplementation((name: string) =>
      name === "WORKER_RUN_CONCURRENCY" ? 2 : undefined,
    );
    const { db, state } = loopDb([
      queuedRun("run-1"),
      queuedRun("run-2"),
      queuedRun("run-3"),
    ]);
    const turns = deferredTurns();
    const controller = new AbortController();

    const loop = runChatRunWorkerLoop({
      db,
      workerId: "w-cap",
      pollIntervalMs: 5,
      signal: controller.signal,
    });

    // Both slots fill without waiting for either turn to finish.
    await vi.waitFor(() => expect(state.claims).toEqual(["run-1", "run-2"]));
    // Saturated: several poll ticks later the third run is still unclaimed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(state.claims).toEqual(["run-1", "run-2"]);

    // Finishing one run frees a slot while run-2 is still mid-turn.
    turns.get("run-1")!();
    await vi.waitFor(() =>
      expect(state.claims).toEqual(["run-1", "run-2", "run-3"]),
    );
    expect(turns.has("run-2")).toBe(true);
    expect(turns.has("run-3")).toBe(true);

    controller.abort();
    for (const finish of turns.values()) finish();
    await loop;
  });

  it("heartbeats every in-flight lease, fenced on the worker id", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(numberFromEnv).mockImplementation((name: string) => {
        if (name === "WORKER_RUN_CONCURRENCY") return 2;
        // Lease 45s → heartbeat interval max(15s, 45s / 3) = 15s.
        if (name === "CHAT_RUN_WORKER_LEASE_MS") return 45_000;
        return undefined;
      });
      const { db, state } = loopDb([queuedRun("run-1"), queuedRun("run-2")]);
      const turns = deferredTurns();
      const controller = new AbortController();

      const loop = runChatRunWorkerLoop({
        db,
        workerId: "w-hb",
        pollIntervalMs: 1_000,
        signal: controller.signal,
      });

      await vi.waitFor(() => expect(state.claims).toEqual(["run-1", "run-2"]));
      await vi.advanceTimersByTimeAsync(15_000);

      const heartbeatsFor = (runId: string) =>
        state.heartbeats.filter((params) => params.includes(runId));
      expect(heartbeatsFor("run-1").length).toBeGreaterThan(0);
      expect(heartbeatsFor("run-2").length).toBeGreaterThan(0);
      for (const params of state.heartbeats) {
        expect(params).toContain("w-hb");
      }

      controller.abort();
      for (const finish of turns.values()) finish();
      await loop;
    } finally {
      vi.useRealTimers();
    }
  });
});
