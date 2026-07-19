import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Run } from "@ai-workspace/db";
import { chatThreads } from "@ai-workspace/db";

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

import { processQueuedChatRun } from "@/lib/chat-run-worker";
import { executeChatTurn } from "@/lib/execute-chat-turn";
import { resolveModelForPurpose } from "@/lib/model-registry";

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

    await processQueuedChatRun({ db, runId: "run-1" });

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
