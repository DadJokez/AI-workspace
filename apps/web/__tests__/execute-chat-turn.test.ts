import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, Database, Run } from "@ai-workspace/db";
import { auditLog, chatMessages, runs, users } from "@ai-workspace/db";
import type { AgentRuntime } from "@ai-workspace/agent-runtime";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import type { ChatStreamEvent } from "@/lib/chat-stream-contract";
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
  artifactContextTextForTurn: vi.fn(
    ({ payload }: { payload: { text?: string } | null }) =>
      payload?.text ?? null,
  ),
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
vi.mock("@/lib/web-egress-policy", () => ({
  loadWebEgressPolicy: vi.fn(async () => ({
    name: "admin_domain_denylist",
    deniedDomains: ["blocked.example"],
  })),
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
vi.mock("@/lib/conversation-resources", () => ({
  revalidateConversationResourceResolution: vi.fn(
    async ({ resolution }: { resolution: unknown }) => resolution,
  ),
}));
vi.mock("@/lib/conversation-resource-runtime", () => ({
  buildConversationResourceMcpServer: vi.fn(() => ({
    type: "http",
    url: "https://example.test/api/mcp/resources",
    allowedTools: ["query"],
  })),
  CONVERSATION_RESOURCE_PROVIDER: "resources",
  CONVERSATION_RESOURCE_QUERY_TOOL: "resources__query",
  loadSelectedResourceImages: vi.fn(async () => []),
}));

import {
  buildTimingMetrics,
  executeChatTurn,
  throttleCancellationCheck,
  type ChatRunTimingMarks,
  type ExecuteChatTurnInput,
} from "@/lib/execute-chat-turn";
import { createToolEventAccumulator } from "@/lib/tool-events";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { createProactiveRunNotification } from "@/lib/notifications";
import { buildChatContextPack } from "@/lib/chat-context-pack";
import { buildTurnToolDiscovery } from "@/lib/tool-discovery";
import { buildTurnContext } from "@/lib/turn-context";
import { builtinToolsForChatRoute } from "@/lib/runtime-builtin-tools";
import { createArtifactsFromAssistantMessage } from "@/lib/workspace-artifacts";
import { createDraftAppVersionsForThreadArtifacts } from "@/lib/apps";

interface FakeDbState {
  runStatus: string;
  runWorkerId?: string;
  runOutputs?: Record<string, unknown> | null;
  inserts: Array<{ table: unknown; values: unknown }>;
  runUpdates: Array<Record<string, unknown>>;
  /** Rows the update chain's .returning() resolves to (fencing tests). */
  updateReturning?: Array<{ id: string }>;
}

function fakeDb(state: FakeDbState): Database {
  const db: Record<string, unknown> = {
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
            if (table === runs) {
              return [
                {
                  status: state.runStatus,
                  workerId: state.runWorkerId ?? "w-test",
                  outputs: state.runOutputs ?? null,
                },
              ];
            }
            return [];
          };
          return {
            limit: async () => resolve(),
            orderBy: async () => resolve(),
            for: async () => resolve(),
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
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.runUpdates.push(values);
          if (table === runs && "outputs" in values) {
            state.runOutputs = values.outputs as Record<string, unknown>;
          }
          const promise = Promise.resolve(undefined);
          return Object.assign(promise, {
            returning: async () => state.updateReturning ?? [{ id: "run-1" }],
          });
        },
      }),
    }),
  };
  db.transaction = async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(db);
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
      yield { type: "done" };
    },
  } as unknown as AgentRuntime;
}

function truncatedRuntime(): AgentRuntime {
  return {
    name: "bedrock",
    runTurn: async function* (turnInput: Record<string, unknown>) {
      await (
        turnInput.onRunStarted as
          | ((metadata: Record<string, unknown>) => Promise<void>)
          | undefined
      )?.({ providerRunId: "truncated-run" });
      yield { type: "text-delta", delta: "partial answer" };
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
  sent: ChatStreamEvent[] = [],
): { input: ExecuteChatTurnInput; sent: ChatStreamEvent[]; state: FakeDbState; captured: { turnInput?: Record<string, unknown> } } {
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
      workerId: "w-test",
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

describe("executeChatTurn — assistant-message audit parity (#456)", () => {
  function messageAuditRows(state: FakeDbState) {
    return state.inserts
      .filter((insert) => insert.table === auditLog)
      .flatMap((insert) =>
        (Array.isArray(insert.values)
          ? (insert.values as Array<Record<string, unknown>>)
          : [insert.values as Record<string, unknown>]
        ).filter((row) => row.actionType === "chat_message_create"),
      );
  }

  it("audits the persisted assistant message on the interactive lane", async () => {
    const { input, state } = inlineInput();
    await executeChatTurn(input);

    const rows = messageAuditRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: "user-1",
      actionType: "chat_message_create",
      status: "succeeded",
      chatThreadId: "thread-1",
      runId: "run-1",
      input: { role: "assistant", lane: "inline" },
    });
  });

  it("audits the persisted assistant message identically on the worker lane", async () => {
    const { input, state } = workerInput();
    await executeChatTurn(input);

    const rows = messageAuditRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actionType: "chat_message_create",
      status: "succeeded",
      input: { role: "assistant", lane: "worker" },
    });
  });

  it("does not audit a message when nothing was persisted", async () => {
    // Worker resume path: assistantMessageId already exists in prior outputs,
    // so no new chat_messages row and no new audit row.
    const { input, state, run } = workerInput();
    run.outputs = { assistantMessageId: "existing-msg" };
    await executeChatTurn(input);

    expect(messageAuditRows(state)).toHaveLength(0);
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

describe("executeChatTurn — historical tool-evidence parity (#434)", () => {
  const evidenceReceipt = {
    candidateCount: 1,
    includedChars: 640,
    maxChars: 8_000,
    maxResultChars: 2_000,
    included: [
      {
        sourceAssistantMessageId: "assistant-score",
        toolCallId: "call-score",
        provider: "web",
        toolName: "search",
        completedAt: "2026-07-23T12:00:00.000Z",
        status: "succeeded" as const,
        stale: false,
        chars: 640,
        truncated: false,
      },
    ],
    omittedToolCallIds: [],
  };

  function emitEvidenceReceipt() {
    vi.mocked(buildTurnContext).mockImplementationOnce(
      ({ messages, onToolEvidenceReceipt }) => {
        onToolEvidenceReceipt?.(evidenceReceipt);
        return messages.map(({ role, content }) => ({ role, content }));
      },
    );
  }

  it("forwards the same receipt through the interactive lane", async () => {
    emitEvidenceReceipt();
    const { input } = inlineInput();
    await executeChatTurn(input);

    expect(buildChatContextPack).toHaveBeenCalledWith(
      expect.objectContaining({
        recentToolEvidenceReceipt: evidenceReceipt,
      }),
    );
  });

  it("forwards the same receipt through the worker lane", async () => {
    emitEvidenceReceipt();
    const { input } = workerInput();
    await executeChatTurn(input);

    expect(buildChatContextPack).toHaveBeenCalledWith(
      expect.objectContaining({
        recentToolEvidenceReceipt: evidenceReceipt,
      }),
    );
  });
});

describe("executeChatTurn — unattended web egress governance (#439)", () => {
  it("keeps web unmounted for unattended runs without a declaration", async () => {
    const { input, captured } = workerInput();
    await executeChatTurn(input);

    expect(builtinToolsForChatRoute).toHaveBeenCalledWith(route, {
      interactive: false,
      webAccessDeclared: false,
    });
    expect(captured.turnInput?.webEgressPolicy).toEqual({
      name: "admin_domain_denylist",
      deniedDomains: ["blocked.example"],
    });
  });

  it("passes an explicit skill declaration through the shared worker pipeline", async () => {
    const { input, captured } = workerInput({
      requestedProviders: ["web", "github"],
    });
    await executeChatTurn(input);

    expect(builtinToolsForChatRoute).toHaveBeenCalledWith(route, {
      interactive: false,
      webAccessDeclared: true,
    });
    expect(captured.turnInput?.webEgressPolicy).toEqual({
      name: "admin_domain_denylist",
      deniedDomains: ["blocked.example"],
    });
  });
});

describe("executeChatTurn — durable conversation resources (#576)", () => {
  it("mounts the same complete-file tool on the shared inline pipeline and persists only the clean prompt", async () => {
    const resourceResolution = {
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
          reason: "previous_run_receipt" as const,
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
    };
    const { input, captured, state } = inlineInput({
      prompt: "folded preview with source bytes",
      persistedPrompt: "continue analyzing the report",
      resourceResolution,
    });

    await executeChatTurn(input);

    expect(captured.turnInput?.mcpServers).toMatchObject({
      github: {},
      resources: {
        url: "https://example.test/api/mcp/resources",
        allowedTools: ["query"],
      },
    });
    expect(captured.turnInput?.requiredToolName).toBe("resources__query");
    expect(buildTurnToolDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        grantedProviders: ["github"],
      }),
    );
    expect(createToolEventAccumulator).toHaveBeenLastCalledWith([
      "github",
      "resources",
    ]);
    expect(buildChatContextPack).toHaveBeenCalledWith(
      expect.objectContaining({ resourceResolution }),
    );
    const inputsRewrite = state.runUpdates.find((update) => "inputs" in update);
    expect(inputsRewrite?.inputs).toMatchObject({
      prompt: "continue analyzing the report",
      resourceResolution,
    });
    expect(JSON.stringify(inputsRewrite?.inputs)).not.toContain(
      "folded preview with source bytes",
    );
  });
});

describe("executeChatTurn — timezone grounding (#432)", () => {
  it("threads the validated zone into runTurn and preserves it in the inline inputs rewrite", async () => {
    const { input, captured, state } = inlineInput({
      userTimeZone: "America/New_York",
    });
    await executeChatTurn(input);

    expect(captured.turnInput?.userTimeZone).toBe("America/New_York");
    // The inline lane rebuilds runs.inputs from scratch; dropping the zone
    // here would strand a queued/retried execution on UTC-only.
    const inputsRewrite = state.runUpdates.find((update) => "inputs" in update);
    expect(inputsRewrite).toBeDefined();
    expect(
      (inputsRewrite!.inputs as Record<string, unknown>).userTimeZone,
    ).toBe("America/New_York");
  });

  it("stays absent end-to-end when no zone was sent", async () => {
    const { input, captured, state } = inlineInput();
    await executeChatTurn(input);

    expect(
      captured.turnInput && "userTimeZone" in captured.turnInput,
    ).toBe(false);
    const inputsRewrite = state.runUpdates.find((update) => "inputs" in update);
    expect(inputsRewrite).toBeDefined();
    expect(
      "userTimeZone" in (inputsRewrite!.inputs as Record<string, unknown>),
    ).toBe(false);
  });

  it("threads a re-validated stored zone through the worker lane's runTurn input", async () => {
    const { input, captured } = workerInput({
      userTimeZone: "Europe/Stockholm",
    });
    await executeChatTurn(input);

    expect(captured.turnInput?.userTimeZone).toBe("Europe/Stockholm");
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

  it("fails instead of persisting a partial answer when the provider stream ends without done", async () => {
    const { input, sent, state } = inlineInput({
      runtime: truncatedRuntime(),
    });

    await executeChatTurn(input);

    expect(sent.at(-1)).toMatchObject({
      type: "failed",
      stopReason: "runtime_error",
    });
    expect(sent.map((event) => event.type)).not.toContain("done");
    expect(sent.map((event) => event.type)).not.toContain("persisted");
    expect(
      state.inserts.find((insert) => insert.table === chatMessages),
    ).toBeUndefined();
    expect(
      state.runUpdates.find((update) => update.status === "failed"),
    ).toMatchObject({
      error: expect.stringContaining("completion event"),
    });
  });

  it("fails the worker run without persisting or notifying success when the provider stream ends without done", async () => {
    const { input, state, run } = workerInput({
      runtime: truncatedRuntime(),
    });

    await executeChatTurn(input);

    expect(
      state.inserts.find((insert) => insert.table === chatMessages),
    ).toBeUndefined();
    expect(
      state.runUpdates.find((update) => update.status === "failed"),
    ).toMatchObject({
      error: expect.stringContaining("completion event"),
    });
    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      input.db,
      run,
      "failed",
      "thread-1",
      { hasProposal: false },
    );
    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).toContain("run_failed");
    expect(eventTypes).not.toContain("run_completed");
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
      { hasProposal: false },
    );

    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).toContain("worker_started");
    expect(eventTypes).toContain("run_completed");
    expect(eventTypes).not.toContain("inline_runtime_started");
  });

  it("persists worker usage behind the active lease for slim polling", async () => {
    const { input, state } = workerInput();
    await executeChatTurn(input);

    const telemetryUpdate = state.runUpdates.find(
      (update) =>
        (update.outputs as { lifecycle?: string } | undefined)?.lifecycle ===
        "provider_running",
    );
    expect(telemetryUpdate).toEqual(
      expect.objectContaining({
        outputs: expect.objectContaining({
          lifecycle: "provider_running",
          usage: expect.objectContaining({ tokensIn: 11, tokensOut: 7 }),
        }),
      }),
    );
    expect(telemetryUpdate?.outputs).not.toHaveProperty("assistantText");
    expect(telemetryUpdate?.outputs).not.toHaveProperty("toolCalls");
    expect(telemetryUpdate?.outputs).not.toHaveProperty("toolResults");
  });

  it.each(["scheduled", "github_event"])(
    "marks %s artifacts and app versions as review proposals",
    async (triggerType) => {
      vi.mocked(createArtifactsFromAssistantMessage).mockResolvedValueOnce([
        {
          id: "artifact-proposal",
          title: "Weekly report",
          filename: "weekly-report.md",
          kind: "document",
          mimeType: "text/markdown",
          sizeBytes: 128,
          source: "assistant",
          threadId: "thread-1",
          chatMessageId: "assistant-msg-1",
          runId: "run-1",
          artifactGroupId: "weekly-report",
          versionNumber: 2,
          supersedesArtifactId: "artifact-v1",
          versionSummary: "Updated weekly report.",
          metadata: null,
          createdAt: "2026-07-23T12:00:00.000Z",
          previewUrl: "/workspace/artifacts/artifact-proposal",
          downloadUrl:
            "/api/workspace/artifacts/artifact-proposal/download",
        },
      ]);
      const fixture = workerInput();
      fixture.run.triggerType = triggerType;

      await executeChatTurn(fixture.input);

      expect(createArtifactsFromAssistantMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          proposal: expect.objectContaining({
            runId: "run-1",
            triggerType,
          }),
        }),
      );
      expect(createDraftAppVersionsForThreadArtifacts).toHaveBeenCalledWith(
        expect.objectContaining({
          proposal: expect.objectContaining({
            runId: "run-1",
            triggerType,
          }),
        }),
      );
      expect(createProactiveRunNotification).toHaveBeenCalledWith(
        fixture.input.db,
        fixture.run,
        "succeeded",
        "thread-1",
        { hasProposal: true },
      );
    },
  );

  it("emits separate app validation and draft creation checkpoints", async () => {
    vi.mocked(createArtifactsFromAssistantMessage).mockResolvedValueOnce([
      {
        id: "artifact-app",
        title: "Dashboard",
        filename: "dashboard.html",
        kind: "file",
        mimeType: "text/html",
        sizeBytes: 128,
        source: "assistant",
        threadId: "thread-1",
        chatMessageId: "assistant-msg-1",
        runId: "run-1",
        artifactGroupId: "dashboard",
        versionNumber: 1,
        supersedesArtifactId: null,
        versionSummary: null,
        metadata: null,
        createdAt: "2026-07-23T12:00:00.000Z",
        previewUrl: "/workspace/artifacts/artifact-app",
        downloadUrl: "/api/workspace/artifacts/artifact-app/download",
      },
    ]);
    vi.mocked(
      createDraftAppVersionsForThreadArtifacts,
    ).mockResolvedValueOnce({
      created: [{ id: "version-4" }] as never,
      rejected: [],
      summaries: [
        {
          id: "version-4",
          appId: "app-1",
          appName: "Dashboard",
          appSlug: "dashboard",
          artifactId: "artifact-app",
          versionNumber: 4,
          status: "draft",
          canDeploy: true,
          previewUrl: "/api/apps/app-1/versions/version-4/content",
          liveUrl: "/apps/dashboard",
        },
      ],
    });
    const { input } = inlineInput();

    await executeChatTurn(input);

    const events = vi.mocked(appendRunEventBestEffort).mock.calls.map(
      ([, event]) => event,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "app_draft_validation_completed",
        status: "succeeded",
        label: "Validated 1 app draft",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "app_draft_versions_created",
        status: "succeeded",
        label: "Created 1 draft app version",
      }),
    );
  });

  it("does not notify or report completion when the worker terminal write is fenced out (#443)", async () => {
    const { input, state } = workerInput();
    // Another worker owns the run: the fenced terminal update matches 0 rows.
    state.updateReturning = [];
    await executeChatTurn(input);

    expect(createProactiveRunNotification).not.toHaveBeenCalled();
    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).not.toContain("run_completed");
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
    expect(input.runtimeAbort.signal.aborted).toBe(true);
    expect(vi.mocked(appendRunEventBestEffort)).toHaveBeenCalledWith(
      "chat-run-event-error",
      expect.objectContaining({
        eventType: "worker_stopped_after_cancel",
        metadata: {
          cancellationObservedVia: "database_poll",
          runtimeRequestAbortAttempted: true,
          providerSessionStopAttempted: false,
        },
      }),
    );
  });

  it("does not report a runtime abort when cancellation is observed after the stream ends", async () => {
    const { input, state } = workerInput();
    input.runtime = {
      name: "bedrock",
      runTurn: async function* (turnInput: Record<string, unknown>) {
        await (
          turnInput.onRunStarted as
            | ((metadata: Record<string, unknown>) => Promise<void>)
            | undefined
        )?.({ providerRunId: "completed-before-cancel" });
        yield { type: "text-delta", delta: "Hello" };
        yield { type: "usage", tokensIn: 11, tokensOut: 7 };
        yield { type: "done" };
        state.runStatus = "canceled";
      },
    } as unknown as AgentRuntime;

    await executeChatTurn(input);

    expect(input.runtimeAbort.signal.aborted).toBe(false);
    expect(vi.mocked(appendRunEventBestEffort)).toHaveBeenCalledWith(
      "chat-run-event-error",
      expect.objectContaining({
        eventType: "worker_stopped_after_cancel",
        metadata: {
          cancellationObservedVia: "database_poll",
          runtimeRequestAbortAttempted: false,
          providerSessionStopAttempted: false,
        },
      }),
    );
  });

  it("persists the friendly timeout error when an aborted provider stream throws", async () => {
    const { input, state } = workerInput();
    let markStreamStarted: (() => void) | undefined;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    input.runtime = {
      name: "bedrock",
      runTurn: async function* (turnInput: Record<string, unknown>) {
        const signal = turnInput.signal as AbortSignal;
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          };
          signal.addEventListener("abort", abort, { once: true });
          markStreamStarted?.();
        });
      },
    } as unknown as AgentRuntime;

    const execution = executeChatTurn(input);
    await streamStarted;
    input.runtimeAbort.abort();
    await execution;

    expect(state.runUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error: "Chat runtime timed out after 60000ms.",
      }),
    );
    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      input.db,
      expect.anything(),
      "failed",
      "thread-1",
      { hasProposal: false },
    );
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

describe("throttleCancellationCheck (#452 worker cancel cadence)", () => {
  it("polls immediately on the first call, then at most once per interval", async () => {
    let clock = 0;
    const probe = vi.fn(async () => false);
    const check = throttleCancellationCheck(probe, {
      intervalMs: 2_000,
      now: () => clock,
    });

    expect(await check()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);

    // A burst of streamed events inside the interval never touches the DB.
    for (clock of [1, 500, 1_999]) {
      expect(await check()).toBe(false);
    }
    expect(probe).toHaveBeenCalledTimes(1);

    clock = 2_000;
    expect(await check()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("reports cancellation on the first poll after the run is canceled", async () => {
    let clock = 0;
    let status = false;
    const probe = vi.fn(async () => status);
    const check = throttleCancellationCheck(probe, {
      intervalMs: 2_000,
      now: () => clock,
    });

    expect(await check()).toBe(false);
    status = true;
    clock = 100; // still inside the interval — cached value
    expect(await check()).toBe(false);
    clock = 2_100;
    expect(await check()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("latches cancellation without re-polling", async () => {
    let clock = 0;
    const probe = vi.fn(async () => true);
    const check = throttleCancellationCheck(probe, {
      intervalMs: 2_000,
      now: () => clock,
    });

    expect(await check()).toBe(true);
    clock = 60_000;
    expect(await check()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
