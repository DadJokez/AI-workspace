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
  resolveModelCandidatesForPurpose: vi.fn(async () => [
    "haiku-4-5",
    "sonnet-4-6",
  ]),
}));
vi.mock("@/lib/run-events", () => ({
  appendRunEventBestEffort: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications", () => ({
  createProactiveRunNotification: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tool-approvals", () => ({
  expirePendingToolApprovals: vi.fn(async () => 0),
}));

import {
  heartbeatRunLease,
  processQueuedChatRun,
  quarantineExhaustedRuns,
  reapOrphanedRuns,
  runChatRunWorkerLoop,
} from "@/lib/chat-run-worker";
import { executeChatTurn, numberFromEnv } from "@/lib/execute-chat-turn";
import { resolveModelCandidatesForPurpose } from "@/lib/model-registry";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { createProactiveRunNotification } from "@/lib/notifications";
import { chatWorkerAbortReason } from "@/lib/chat-worker-abort";
import { expirePendingToolApprovals } from "@/lib/tool-approvals";

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
  vi.mocked(numberFromEnv).mockImplementation(() => undefined);
});

describe("processQueuedChatRun", () => {
  it("records the default fallback when the worker's enablement read fails", async () => {
    const receipt = {
      reason: "model_enablement_unavailable" as const,
      message: "Model enablement unavailable — using the default",
      purpose: "durable-local" as const,
      modelId: "sonnet-4-6" as const,
    };
    vi.mocked(resolveModelCandidatesForPurpose).mockImplementationOnce(async (_db, _purpose, options) => {
      options?.onUnavailable?.(receipt);
      return ["sonnet-4-6"];
    });
    await processQueuedChatRun({ db: fakeDb(claimedRun()), runId: "run-1" });
    expect(appendRunEventBestEffort).toHaveBeenCalledWith("chat-run-event-error", expect.objectContaining({
      eventType: "model_enablement_fallback",
      label: receipt.message,
      metadata: { enablementFallback: receipt },
    }));
    expect(vi.mocked(executeChatTurn).mock.calls[0]![0]).toMatchObject({
      modelId: "sonnet-4-6", modelCandidates: ["sonnet-4-6"],
    });
  });

  it("re-validates the stored model against the registry at turn time (#442 drift fix)", async () => {
    const run = claimedRun();
    const db = fakeDb(run);

    const result = await processQueuedChatRun({ db, runId: "run-1" });

    expect(result).toEqual({ status: "succeeded", runId: "run-1" });
    // Legacy worker runs without a stored route run on the durable lane.
    expect(resolveModelCandidatesForPurpose).toHaveBeenCalledWith(
      db,
      "durable-local",
      {
        preferred: "sonnet-4-6",
        onUnavailable: expect.any(Function),
      },
    );
    expect(executeChatTurn).toHaveBeenCalledTimes(1);
    const turn = vi.mocked(executeChatTurn).mock.calls[0]![0];
    expect(turn.modelId).toBe("haiku-4-5");
    expect(turn.modelCandidates).toEqual(["haiku-4-5", "sonnet-4-6"]);
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

  it("carries authoritative consumption into an approval resume", async () => {
    const envelope = {
      schema: "comparative.run-budget.v1" as const,
      version: 1 as const,
      governingLayer: "organization" as const,
      limits: {
        tokens: 1_000_000,
        usd: 10,
        wallClockMs: 3_600_000,
        toolIterations: 8,
      },
    };
    const consumed = {
      tokens: 42_000,
      usd: 0.42,
      wallClockMs: 9_000,
      toolIterations: 1,
    };
    const run = claimedRun({
      status: "waiting_for_approval",
      inputs: {
        prompt: "continue",
        threadId: "thread-1",
        userMessageId: "user-msg-1",
        executionMode: "local",
        runBudget: { envelope },
      },
      outputs: {
        budgetReceipt: {
          schema: "comparative.run-budget-receipt.v1",
          version: 1,
          governingLayer: "organization",
          limits: envelope.limits,
          consumed,
          partial: false,
        },
      },
    } as Partial<Run>);

    await processQueuedChatRun({ db: fakeDb(run), runId: "run-1" });

    expect(vi.mocked(executeChatTurn).mock.calls[0]![0].runBudget).toEqual({
      envelope,
      consumed,
    });
  });

  it("carries a real timeout reason into a blocked provider turn", async () => {
    vi.mocked(numberFromEnv).mockImplementation((name: string) =>
      name === "CHAT_WORKER_RUNTIME_TIMEOUT_MS" ? 5 : undefined,
    );
    let observedReason: string | null = null;
    vi.mocked(executeChatTurn).mockImplementationOnce(
      async ({ runtimeAbort }: { runtimeAbort: AbortController }) => {
        await new Promise<void>((resolve) => {
          runtimeAbort.signal.addEventListener(
            "abort",
            () => {
              observedReason = chatWorkerAbortReason(runtimeAbort.signal);
              resolve();
            },
            { once: true },
          );
        });
      },
    );

    const run = claimedRun();
    const result = await processQueuedChatRun({
      db: fakeDb(run),
      runId: run.id,
    });

    expect(result).toEqual({ status: "succeeded", runId: run.id });
    expect(observedReason).toBe("timeout");
  });

  it("carries shutdown instead of timeout from the worker signal", async () => {
    const controller = new AbortController();
    let observedReason: string | null = null;
    vi.mocked(executeChatTurn).mockImplementationOnce(
      async ({ runtimeAbort }: { runtimeAbort: AbortController }) => {
        await new Promise<void>((resolve) => {
          runtimeAbort.signal.addEventListener(
            "abort",
            () => {
              observedReason = chatWorkerAbortReason(runtimeAbort.signal);
              resolve();
            },
            { once: true },
          );
        });
      },
    );

    const run = claimedRun();
    const execution = processQueuedChatRun({
      db: fakeDb(run),
      runId: run.id,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(executeChatTurn).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(execution).resolves.toEqual({
      status: "succeeded",
      runId: run.id,
    });
    expect(observedReason).toBe("shutdown");
  });

  it.each([
    { currentStatus: "running", expectedReason: "lease_lost" },
    { currentStatus: "canceled", expectedReason: "canceled" },
  ])(
    "aborts a blocked turn as $expectedReason when the heartbeat fence fails",
    async ({ currentStatus, expectedReason }) => {
      vi.useFakeTimers();
      try {
        vi.mocked(numberFromEnv).mockImplementation((name: string) =>
          name === "CHAT_RUN_WORKER_LEASE_MS" ? 45_000 : undefined,
        );
        const run = claimedRun();
        const db = {
          update: () => ({
            set: (values: Record<string, unknown>) => ({
              where: () => ({
                returning: async () =>
                  values.status === "running" ? [run] : [],
              }),
            }),
          }),
          select: () => ({
            from: (table: unknown) => ({
              where: () => ({
                limit: async () =>
                  table === chatThreads
                    ? [{ id: "thread-1", summary: null }]
                    : [{ status: currentStatus }],
              }),
            }),
          }),
        } as unknown as Database;
        let observedReason: string | null = null;
        vi.mocked(executeChatTurn).mockImplementationOnce(
          async ({ runtimeAbort }: { runtimeAbort: AbortController }) => {
            await new Promise<void>((resolve) => {
              runtimeAbort.signal.addEventListener(
                "abort",
                () => {
                  observedReason = chatWorkerAbortReason(runtimeAbort.signal);
                  resolve();
                },
                { once: true },
              );
            });
          },
        );

        const execution = processQueuedChatRun({ db, runId: run.id });
        await vi.advanceTimersByTimeAsync(0);
        expect(executeChatTurn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(15_000);

        await expect(execution).resolves.toEqual({
          status: "succeeded",
          runId: run.id,
        });
        expect(observedReason).toBe(expectedReason);
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ status: "running" }],
          }),
        }),
      }),
    } as unknown as Database;
    await expect(heartbeatRunLease(emptyDb, "run-1", "w-test")).resolves.toBe(
      "lease_lost",
    );

    const heldDb = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: "run-1" }] }),
        }),
      }),
    } as unknown as Database;
    await expect(heartbeatRunLease(heldDb, "run-1", "w-test")).resolves.toBe(
      "held",
    );

    const canceledDb = {
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [] }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ status: "canceled" }],
          }),
        }),
      }),
    } as unknown as Database;
    await expect(
      heartbeatRunLease(canceledDb, "run-1", "w-test"),
    ).resolves.toBe(
      "canceled",
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

/**
 * #464 — a run whose execution kills the worker never reaches markRunFailed,
 * so before this the lease simply lapsed and the same poison pill was
 * re-claimed forever, starving every slot on a 3-slot lane. The claim is now
 * bounded by an attempt ceiling and exhausted runs are retired.
 */
describe("poison-pill attempt ceiling (#464)", () => {
  function capturingDb(returning: () => Promise<unknown[]>) {
    const captured: Array<{
      condition: unknown;
      values: Record<string, unknown>;
    }> = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: unknown) => {
            captured.push({ condition, values });
            return { returning };
          },
        }),
      }),
    } as unknown as Database;
    return { db, captured };
  }

  const rendered = (condition: unknown) =>
    new PgDialect().sqlToQuery(condition as never);

  it("refuses to claim a run that has burned its ceiling", async () => {
    const { db, captured } = capturingDb(async () => []);

    const result = await processQueuedChatRun({ db, runId: "run-1" });

    // No row comes back, so the run is not executed one more time.
    expect(result).toEqual({ status: "idle" });
    expect(executeChatTurn).not.toHaveBeenCalled();
    const { sql, params } = rendered(captured[0]!.condition);
    expect(sql).toContain('"attempt_count" <');
    expect(params).toContain(3);
  });

  it("takes the ceiling from CHAT_RUN_MAX_ATTEMPTS", async () => {
    vi.mocked(numberFromEnv).mockImplementation((name: string) =>
      name === "CHAT_RUN_MAX_ATTEMPTS" ? 5 : undefined,
    );
    const { db, captured } = capturingDb(async () => []);

    await processQueuedChatRun({ db, runId: "run-1" });

    expect(rendered(captured[0]!.condition).params).toContain(5);
  });

  it("quarantines exhausted runs with a reason the run-failure alarm sees", async () => {
    const poison = claimedRun({
      triggerType: "chat",
      attemptCount: 3,
    } as Partial<Run>);
    const { db, captured } = capturingDb(async () => [poison]);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    let quarantined: number;
    let logged: string;
    try {
      quarantined = await quarantineExhaustedRuns({ db });
    } finally {
      // mockRestore() wipes mock.calls, so read the log before restoring.
      logged = stderr.mock.calls.map((call) => String(call[0])).join("");
      stderr.mockRestore();
    }

    expect(quarantined).toBe(1);
    const { condition, values } = captured[0]!;
    expect(values.status).toBe("failed");
    expect(values.error).toContain("3-attempt ceiling");
    // Releases the lane: no owner, and no lease left to expire and reclaim on.
    expect(values.workerId).toBeNull();
    expect(values.leaseExpiresAt).toBeNull();

    const { sql, params } = rendered(condition);
    expect(sql).toContain('"attempt_count" >=');
    expect(params).toContain(3);
    // Scoped to runs a worker would otherwise re-claim, so a run executing
    // under a live lease is never failed out from under its owner.
    expect(sql).toContain('"lease_expires_at" <');
    expect(params).toContain("queued");

    // setup-ops-alarms.sh filters the chat-worker log group on this marker.
    expect(logged).toContain("[chat-run-worker-error]");
    expect(logged).toContain("attempt_ceiling_exhausted");

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

  it("sweeps exhausted runs from the worker loop", async () => {
    const terminalErrors: unknown[] = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (values.status === "failed") terminalErrors.push(values.error);
              return [];
            },
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [] }),
            limit: async () => [],
          }),
        }),
      }),
    } as unknown as Database;
    const controller = new AbortController();

    const loop = runChatRunWorkerLoop({
      db,
      workerId: "w-sweep",
      pollIntervalMs: 5,
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(
        terminalErrors.some((error) =>
          String(error).includes("attempt ceiling"),
        ),
      ).toBe(true),
    );
    expect(expirePendingToolApprovals).toHaveBeenCalledWith({ db });

    controller.abort();
    await loop;
  });
});
