import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, Database, Run } from "@ai-workspace/db";
import { auditLog, chatMessages, runs, users } from "@ai-workspace/db";
import type { AgentRuntime } from "@ai-workspace/agent-runtime";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import type { RuntimeModelSelection } from "@/lib/runtime-model-policy";

/**
 * #442 — the shared chat-turn pipeline. These tests pin the exact behaviors
 * the twin-runner fork had let drift between lanes:
 * - the denied-provider attestation audit row is written on BOTH lanes,
 * - each lane keeps its historical prompt slot (systemPrompt vs
 *   firstTurnPreamble),
 * - the tool-event accumulator gets provider hints on both lanes,
 * - the persist tail stores the assistant answer and reports terminal state.
 */

vi.mock("@/lib/chat-context-pack", () => ({
  buildChatContextPack: vi.fn(() => ({
    prompt: {
      systemPrompt: "SYSTEM_PROMPT",
      volatileSystemSuffix: "VOLATILE",
      messages: [{ role: "user", content: "hi" }],
    },
    receipts: [{ id: "receipt-1" }],
  })),
}));
vi.mock("@/lib/capability-graph", () => ({
  loadUserCapabilityGraph: vi.fn(async () => ({})),
}));
vi.mock("@/lib/audit-tool-events", () => ({
  buildToolAuditRows: vi.fn(() => []),
}));
vi.mock("@/lib/chat-routing", () => ({
  toolDiscoveryModeFromEnv: vi.fn(() => "off"),
}));
vi.mock("@/lib/thread-activation", () => ({
  persistActivationFromEvent: vi.fn(async ({ currentSignature }) => currentSignature),
}));
vi.mock("@/lib/tool-discovery", () => ({
  buildTurnToolDiscovery: vi.fn(async () => undefined),
}));
vi.mock("@/lib/chat-mcp-provider-scope", () => ({
  resolveChatMcpProviderScope: vi.fn(() => ({
    accountStatusOptions: {},
    mountOptions: {},
  })),
}));
vi.mock("@/lib/memory-capture", () => ({
  enqueueMemoryCapture: vi.fn(async () => undefined),
  startInProcessMemoryCaptureScheduler: vi.fn(),
}));
vi.mock("@/lib/oauth/mcp-servers", () => ({
  buildUserMcpServers: vi.fn(async () => ({
    mcpServers: { github: { url: "https://example.test" } },
    requiredToolName: undefined,
    deniedProviders: [],
    writeAuthorizationReceipts: [],
  })),
  loadUserMcpProviderStatus: vi.fn(async () => ({
    connectedProviders: ["github", "salesforce"],
    allowedProviders: ["github"],
    deniedProviders: ["salesforce"],
    toolActions: {},
  })),
}));
vi.mock("@/lib/artifact-context", () => ({
  buildArtifactContextPayload: vi.fn(async () => null),
  buildArtifactLookupMessage: vi.fn(() => "lookup"),
}));
vi.mock("@/lib/artifact-revisions", () => ({
  resolveArtifactContextTargets: vi.fn(() => ({
    artifactContextTarget: null,
    separateFromArtifact: null,
  })),
}));
vi.mock("@/lib/apps", () => ({
  buildAppEditContext: vi.fn(async () => null),
  createDraftAppVersionsForThreadArtifacts: vi.fn(async () => ({
    summaries: [],
    created: [],
    rejected: [],
  })),
}));
vi.mock("@/lib/run-events", () => ({
  appendRunEventBestEffort: vi.fn(async () => undefined),
  appendToolCallRunEvent: vi.fn(async () => undefined),
  appendToolResultRunEvent: vi.fn(async () => undefined),
  nextRunEventSequence: vi.fn(async () => 1),
}));
vi.mock("@/lib/tool-events", () => ({
  createToolEventAccumulator: vi.fn(() => ({
    recordCall: vi.fn(),
    recordResult: vi.fn(),
    calls: () => [],
    results: () => [],
  })),
}));
vi.mock("@/lib/thread-metadata", () => ({
  refreshThreadPresentationMetadata: vi.fn(async () => undefined),
}));
vi.mock("@/lib/turn-context", () => ({
  buildTurnContext: vi.fn(({ messages }) => messages),
}));
vi.mock("@/lib/runtime-attachments", () => ({
  attachUploadedFilesToLatestUserMessage: vi.fn((messages) => messages),
}));
vi.mock("@/lib/runtime-builtin-tools", () => ({
  builtinToolsForChatRoute: vi.fn(() => []),
}));
vi.mock("@/lib/runtime-usage", () => ({
  normalizeRuntimeUsage: vi.fn(() => ({
    tokensIn: 11,
    tokensOut: 7,
    inputTokens: 11,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  })),
}));
vi.mock("@/lib/run-trace", () => ({
  createProviderTraceAccumulator: vi.fn(() => ({
    record: vi.fn(),
    snapshot: vi.fn(() => ({ requests: [] })),
  })),
  persistProviderTraceCapture: vi.fn(async () => undefined),
}));
vi.mock("@/lib/vault-memory", () => ({
  loadApprovedVaultMarkdown: vi.fn(async () => null),
}));
vi.mock("@/lib/workspace-artifacts", () => ({
  createArtifactsFromAssistantMessage: vi.fn(async () => []),
}));
vi.mock("@/lib/recommendation-persistence", () => ({
  createRecommendationsForAssistantMessage: vi.fn(async () => []),
  loadRecentRecommendationsForThread: vi.fn(async () => []),
}));
vi.mock("@/lib/notifications", () => ({
  createProactiveRunNotification: vi.fn(async () => undefined),
}));

import {
  buildTimingMetrics,
  executeChatTurn,
  type ChatRunTimingMarks,
  type ExecuteChatTurnInput,
} from "@/lib/execute-chat-turn";
import { createToolEventAccumulator } from "@/lib/tool-events";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { createProactiveRunNotification } from "@/lib/notifications";

interface FakeDbState {
  runStatus: string;
  inserts: Array<{ table: unknown; values: unknown }>;
  runUpdates: Array<Record<string, unknown>>;
}

function fakeDb(state: FakeDbState): Database {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const resolve = () => {
            if (table === users) {
              return [
                {
                  displayName: "Rob",
                  assistantName: null,
                  customInstructions: null,
                  role: "user" as const,
                },
              ];
            }
            if (table === chatMessages) return [];
            if (table === runs) return [{ status: state.runStatus }];
            return [];
          };
          return {
            limit: async () => resolve(),
            orderBy: async () => resolve(),
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        state.inserts.push({ table, values });
        const promise = Promise.resolve(undefined);
        return Object.assign(promise, {
          returning: async () => [{ id: "assistant-msg-1" }],
        });
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.runUpdates.push(values);
          const promise = Promise.resolve(undefined);
          return Object.assign(promise, {
            returning: async () => [{ id: "run-1" }],
          });
        },
      }),
    }),
  };
  return db as unknown as Database;
}

function fakeRuntime(captured: { turnInput?: Record<string, unknown> }): AgentRuntime {
  return {
    name: "bedrock",
    runTurn: async function* (input: Record<string, unknown>) {
      captured.turnInput = input;
      await (
        input.onRunStarted as (m: Record<string, unknown>) => Promise<void>
      )?.({ providerRunId: "pr-1" });
      yield { type: "text-delta", delta: "Hello" };
      yield { type: "usage", tokensIn: 11, tokensOut: 7 };
    },
  } as unknown as AgentRuntime;
}

const route: ChatRuntimeRoute = {
  lane: "tool-local",
  routingMode: "regex",
  executionMode: "local",
  runtimeTarget: "direct-chat",
  runtimeV2: true,
  useWorker: false,
  useMcp: true,
  includeVaultContext: true,
  reasons: ["test"],
} as ChatRuntimeRoute;

const thread = { id: "thread-1", summary: null } as unknown as ChatThread;

const modelSelection: RuntimeModelSelection = {
  requestedModelId: "sonnet-4-6",
  modelId: "sonnet-4-6",
  providerModelId: "us.anthropic.claude-sonnet-4-6",
  reason: "requested_model_supported",
};

function inlineInput(
  overrides: Partial<ExecuteChatTurnInput> = {},
  sent: Array<Record<string, unknown>> = [],
): { input: ExecuteChatTurnInput; sent: Array<Record<string, unknown>>; state: FakeDbState; captured: { turnInput?: Record<string, unknown> } } {
  const state: FakeDbState = { runStatus: "running", inserts: [], runUpdates: [] };
  const captured: { turnInput?: Record<string, unknown> } = {};
  const timing: ChatRunTimingMarks = {
    requestStartedAt: new Date(),
    inlineStartedAt: new Date(),
  };
  const input: ExecuteChatTurnInput = {
    db: fakeDb(state),
    runId: "run-1",
    userId: "user-1",
    thread,
    prompt: "hi",
    userMessageId: "user-msg-1",
    route,
    runtime: fakeRuntime(captured),
    runtimeAbort: new AbortController(),
    modelId: "sonnet-4-6",
    uploadedFiles: [],
    suppressedSkillIds: [],
    interactive: true,
    lane: {
      kind: "inline",
      send: (event) => sent.push(event),
      diagnosticStreamEnabled: false,
      timing,
      modelSelection,
      requestedModelId: "sonnet-4-6",
      modelOverride: false,
    },
    ...overrides,
  };
  return { input, sent, state, captured };
}

function workerInput(
  overrides: Partial<ExecuteChatTurnInput> = {},
): { input: ExecuteChatTurnInput; state: FakeDbState; captured: { turnInput?: Record<string, unknown> }; run: Run } {
  const state: FakeDbState = { runStatus: "running", inserts: [], runUpdates: [] };
  const captured: { turnInput?: Record<string, unknown> } = {};
  const run = {
    id: "run-1",
    userId: "user-1",
    threadId: "thread-1",
    triggerType: "chat",
    modelId: "sonnet-4-6",
    inputs: {},
    outputs: null,
  } as unknown as Run;
  const input: ExecuteChatTurnInput = {
    db: fakeDb(state),
    runId: "run-1",
    userId: "user-1",
    thread,
    prompt: "hi",
    userMessageId: "user-msg-1",
    route,
    runtime: fakeRuntime(captured),
    runtimeAbort: new AbortController(),
    modelId: "sonnet-4-6",
    uploadedFiles: [],
    suppressedSkillIds: [],
    interactive: false,
    lane: {
      kind: "worker",
      run,
      storedInputs: { prompt: "hi", threadId: "thread-1" },
      executionMode: "local",
      timeoutMs: 60_000,
      preferArtifactFallback: false,
      storedArtifactTarget: null,
      storedSeparateFromArtifact: null,
    },
    ...overrides,
  };
  return { input, state, captured, run };
}

function attestationInserts(state: FakeDbState) {
  return state.inserts.filter(
    (insert) =>
      insert.table === auditLog &&
      Array.isArray(insert.values) &&
      (insert.values as Array<Record<string, unknown>>).some(
        (row) => row.actionType === "mcp_tool_attestation",
      ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeChatTurn — denied-provider attestation audit (#442 drift fix)", () => {
  it("writes the denied attestation audit row on the interactive lane", async () => {
    const { input, state } = inlineInput();
    await executeChatTurn(input);

    const audits = attestationInserts(state);
    expect(audits).toHaveLength(1);
    const rows = audits[0]!.values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: "user-1",
      actionType: "mcp_tool_attestation",
      status: "denied",
      provider: "salesforce",
      runId: "run-1",
      chatThreadId: "thread-1",
    });
  });

  it("writes the same audit row on the worker lane", async () => {
    const { input, state } = workerInput();
    await executeChatTurn(input);

    const audits = attestationInserts(state);
    expect(audits).toHaveLength(1);
    const rows = audits[0]!.values as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      actionType: "mcp_tool_attestation",
      status: "denied",
      provider: "salesforce",
    });
  });
});

describe("executeChatTurn — lane prompt slots", () => {
  it("keeps the interactive lane on systemPrompt", async () => {
    const { input, captured } = inlineInput();
    await executeChatTurn(input);

    expect(captured.turnInput?.systemPrompt).toBe("SYSTEM_PROMPT");
    expect(captured.turnInput?.firstTurnPreamble).toBeUndefined();
    expect(captured.turnInput?.volatileSystemSuffix).toBe("VOLATILE");
  });

  it("keeps the worker lane on firstTurnPreamble", async () => {
    const { input, captured } = workerInput();
    await executeChatTurn(input);

    expect(captured.turnInput?.firstTurnPreamble).toBe("SYSTEM_PROMPT");
    expect(captured.turnInput?.systemPrompt).toBeUndefined();
    expect(captured.turnInput?.volatileSystemSuffix).toBe("VOLATILE");
  });
});

describe("executeChatTurn — tool-event provider hints (#442 drift fix)", () => {
  it("passes mounted providers to the accumulator on both lanes", async () => {
    const inline = inlineInput();
    await executeChatTurn(inline.input);
    expect(createToolEventAccumulator).toHaveBeenLastCalledWith(["github"]);

    const worker = workerInput();
    await executeChatTurn(worker.input);
    expect(createToolEventAccumulator).toHaveBeenLastCalledWith(["github"]);
  });
});

describe("executeChatTurn — persist tail", () => {
  it("stores the assistant answer and finishes the run on the inline lane", async () => {
    const { input, sent, state } = inlineInput();
    await executeChatTurn(input);

    const messageInsert = state.inserts.find(
      (insert) => insert.table === chatMessages,
    );
    expect(messageInsert?.values).toMatchObject({
      threadId: "thread-1",
      role: "assistant",
      content: "Hello",
      tokensIn: 11,
      tokensOut: 7,
    });

    const terminal = state.runUpdates.find(
      (update) => update.status === "succeeded",
    );
    expect(terminal).toBeDefined();
    expect(terminal).toMatchObject({ error: null, workerId: null });

    const types = sent.map((event) => event.type);
    expect(types[0]).toBe("model");
    expect(types).toContain("text-delta");
    expect(types).toContain("done");
    const persisted = sent.find((event) => event.type === "persisted");
    expect(persisted).toMatchObject({
      assistantMessageId: "assistant-msg-1",
      tokensIn: 11,
      tokensOut: 7,
      runId: "run-1",
      threadId: "thread-1",
    });

    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).toContain("context_pack_assembled");
    expect(eventTypes).toContain("inline_runtime_started");
    expect(eventTypes).toContain("run_completed");
  });

  it("stores the assistant answer and notifies on the worker lane", async () => {
    const { input, state, run } = workerInput();
    await executeChatTurn(input);

    const messageInsert = state.inserts.find(
      (insert) => insert.table === chatMessages,
    );
    expect(messageInsert?.values).toMatchObject({
      role: "assistant",
      content: "Hello",
    });

    const terminal = state.runUpdates.find(
      (update) => update.status === "succeeded",
    );
    expect(terminal).toBeDefined();

    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      input.db,
      run,
      "succeeded",
      "thread-1",
    );

    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).toContain("worker_started");
    expect(eventTypes).toContain("run_completed");
    expect(eventTypes).not.toContain("inline_runtime_started");
  });

  it("does not persist or notify when the worker run was canceled mid-turn", async () => {
    const { input, state } = workerInput();
    // Cancel is observed on the first event-loop check.
    (input.db as unknown as { select: unknown }).select = () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === runs
              ? [{ status: "canceled" }]
              : [
                  {
                    displayName: "Rob",
                    assistantName: null,
                    customInstructions: null,
                    role: "user" as const,
                  },
                ],
          orderBy: async () => [],
        }),
      }),
    });
    await executeChatTurn(input);

    const messageInsert = state.inserts.find(
      (insert) => insert.table === chatMessages,
    );
    expect(messageInsert).toBeUndefined();
    expect(createProactiveRunNotification).not.toHaveBeenCalled();
    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).toContain("worker_stopped_after_cancel");
  });
});

describe("buildTimingMetrics", () => {
  it("populates first-token latency once the first token arrives", () => {
    const requestStartedAt = new Date("2026-05-30T12:00:00.000Z");

    const metrics = buildTimingMetrics({
      requestStartedAt,
      inlineStartedAt: new Date("2026-05-30T12:00:00.025Z"),
      contextReadyAt: new Date("2026-05-30T12:00:00.080Z"),
      providerStartedAt: new Date("2026-05-30T12:00:00.100Z"),
      firstTokenAt: new Date("2026-05-30T12:00:00.350Z"),
      completedAt: new Date("2026-05-30T12:00:00.900Z"),
    });

    expect(metrics).toMatchObject({
      requestStartedAt: "2026-05-30T12:00:00.000Z",
      inlineStartedAt: "2026-05-30T12:00:00.025Z",
      firstTokenAt: "2026-05-30T12:00:00.350Z",
      completedAt: "2026-05-30T12:00:00.900Z",
      requestToInlineMs: 25,
      inlineToContextReadyMs: 55,
      requestToProviderMs: 100,
      requestToFirstTokenMs: 350,
      providerToFirstTokenMs: 250,
      requestToCompletedMs: 900,
    });
  });

  it("omits first-token latency before text streams", () => {
    const metrics = buildTimingMetrics({
      requestStartedAt: new Date("2026-05-30T12:00:00.000Z"),
      inlineStartedAt: new Date("2026-05-30T12:00:00.025Z"),
      providerStartedAt: new Date("2026-05-30T12:00:00.100Z"),
    });

    expect(metrics.requestToFirstTokenMs).toBeUndefined();
    expect(metrics.providerToFirstTokenMs).toBeUndefined();
  });
});
