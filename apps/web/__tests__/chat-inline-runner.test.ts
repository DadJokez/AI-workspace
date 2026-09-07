import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, Database } from "@ai-workspace/db";
import { RUN_BUDGET_SCHEMA } from "@ai-workspace/agent";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";

/**
 * #443 — the inline shell's crash discipline: a throw anywhere in the shared
 * pipeline marks the run failed (never stranding it in `running`) and still
 * propagates so the route can report the error, while a clean turn leaves
 * the terminal state to the pipeline's own persist tail.
 */

vi.mock("@/lib/execute-chat-turn", () => ({
  executeChatTurn: vi.fn(async () => undefined),
}));
vi.mock("@ai-workspace/agent-runtime", () => ({
  getRuntime: vi.fn(() => ({ name: "bedrock" })),
}));
vi.mock("@/lib/model-registry", () => ({
  enabledModelsForPurpose: vi.fn(async () => ["sonnet-4-6"]),
  orderModelCandidatesForPurpose: vi.fn(() => ["sonnet-4-6"]),
}));
vi.mock("@/lib/runtime-model-policy", () => ({
  resolveRuntimeModelSelection: vi.fn(() => ({
    requestedModelId: "sonnet-4-6",
    modelId: "sonnet-4-6",
    providerModelId: "us.anthropic.claude-sonnet-4-6",
    reason: "requested_model_supported",
  })),
}));
vi.mock("@/lib/run-events", () => ({
  appendRunEventBestEffort: vi.fn(async () => undefined),
}));

import { streamInlineChatRun } from "@/lib/chat-inline-runner";
import { executeChatTurn } from "@/lib/execute-chat-turn";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { enabledModelsForPurpose } from "@/lib/model-registry";

function fakeDb(updates: Array<Record<string, unknown>>): Database {
  return {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          const promise = Promise.resolve(undefined);
          return Object.assign(promise, {
            returning: async () => [{ id: "run-1" }],
          });
        },
      }),
    }),
  } as unknown as Database;
}

function inlineArgs(db: Database) {
  return {
    db,
    runId: "run-1",
    thread: { id: "thread-1", summary: null } as unknown as ChatThread,
    userId: "user-1",
    userMessageId: "user-msg-1",
    prompt: "hi",
    modelId: "sonnet-4-6",
    runBudget: {
      envelope: {
        schema: RUN_BUDGET_SCHEMA,
        version: 1 as const,
        governingLayer: "organization" as const,
        limits: {
          tokens: 400_000,
          usd: 4,
          wallClockMs: 900_000,
          toolIterations: 8,
        },
      },
    },
    route: {
      lane: "tool-local",
      routingMode: "regex",
      executionMode: "local",
      runtimeTarget: "direct-chat",
      runtimeV2: true,
      useWorker: false,
      useMcp: true,
      includeVaultContext: true,
      reasons: ["test"],
    } as ChatRuntimeRoute,
    send: () => {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("streamInlineChatRun crash discipline (#443)", () => {
  it("carries an outage into the model selection receipt", async () => {
    const receipt = {
      reason: "model_enablement_unavailable" as const,
      message: "Model enablement unavailable — using the default",
      purpose: "tool-local" as const,
      modelId: "sonnet-4-6" as const,
    };
    vi.mocked(enabledModelsForPurpose).mockImplementationOnce(async (_db, _purpose, options) => {
      options?.onUnavailable?.(receipt);
      return ["sonnet-4-6"];
    });
    await streamInlineChatRun(inlineArgs(fakeDb([])));
    expect(vi.mocked(executeChatTurn).mock.calls[0]![0]).toMatchObject({
      modelId: "sonnet-4-6",
      lane: { modelSelection: { enablementFallback: receipt } },
    });
  });

  it("marks the run failed and rethrows when the pipeline throws", async () => {
    vi.mocked(executeChatTurn).mockRejectedValueOnce(
      new Error("context assembly exploded"),
    );
    const updates: Array<Record<string, unknown>> = [];

    await expect(streamInlineChatRun(inlineArgs(fakeDb(updates)))).rejects.toThrow(
      "context assembly exploded",
    );

    const terminal = updates.find((update) => update.status === "failed");
    expect(terminal).toMatchObject({
      status: "failed",
      error: "context assembly exploded",
    });
    expect(appendRunEventBestEffort).toHaveBeenCalledWith(
      "chat-inline-event-error",
      expect.objectContaining({
        runId: "run-1",
        eventType: "run_failed",
        status: "failed",
      }),
    );
  });

  it("writes no failure state when the pipeline completes", async () => {
    const updates: Array<Record<string, unknown>> = [];

    await streamInlineChatRun(inlineArgs(fakeDb(updates)));

    expect(updates.find((update) => update.status === "failed")).toBeUndefined();
    expect(appendRunEventBestEffort).not.toHaveBeenCalled();
  });

  it("passes the clean prompt and durable resource receipt into the shared lane (#576)", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const args = {
      ...inlineArgs(fakeDb(updates)),
      prompt: "folded preview that is only valid on this turn",
      persistedPrompt: "analyze the attached report",
      resourceResolution: {
        version: 1 as const,
        status: "selected" as const,
        intent: true,
        selected: [
          {
            resourceId: "resource-report",
            filename: "report.csv",
            mimeType: "text/csv",
            kind: "spreadsheet" as const,
            sizeBytes: 7_800_000,
            representation: "tabular_dataset" as const,
            coverage: "full" as const,
            reason: "current_upload" as const,
          },
        ],
        candidates: [
          {
            resourceId: "resource-report",
            filename: "report.csv",
            kind: "spreadsheet" as const,
          },
        ],
        requiresCompleteFileTool: true,
      },
    };

    await streamInlineChatRun(args);

    expect(vi.mocked(executeChatTurn).mock.calls[0]![0]).toMatchObject({
      prompt: "folded preview that is only valid on this turn",
      persistedPrompt: "analyze the attached report",
      modelCandidates: ["sonnet-4-6"],
      resourceResolution: args.resourceResolution,
    });
  });
});
