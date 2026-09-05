import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, Database, Run } from "@ai-workspace/db";
import { auditLog, chatMessages, runs, users } from "@ai-workspace/db";
import type { AgentRuntime } from "@ai-workspace/agent-runtime";
import {
  RUN_BUDGET_SCHEMA,
  estimateUsageCostUsd,
  type RunBudgetReceipt,
  type RunBudgetState,
  type TokenUsage,
} from "@ai-workspace/agent";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import { resolveStoredRunBudget } from "@/lib/run-budget-policy";
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
    receipts: [
      {
        schema: "context-pack.v2",
        version: 1,
        tools: { providers: [] },
      },
    ],
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
    toolPolicyDecisions: {},
  })),
}));
vi.mock("@/lib/artifact-context", () => ({
  buildArtifactContextPayload: vi.fn(async () => null),
  buildArtifactLookupMessage: vi.fn(() => "lookup"),
  artifactContextTextForTurn: vi.fn(
    ({ payload }: { payload: { text?: string } | null }) =>
      payload?.text ?? null,
  ),
  // #647: fixtures are plain prompts with no document request.
  hasDocumentCreationIntent: vi.fn(() => false),
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
vi.mock("@/lib/tool-approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tool-approvals")>();
  return {
    ...actual,
    loadToolApprovalGrants: vi.fn(async () => []),
    loadStandingToolApprovalGrants: vi.fn(async () => []),
    pauseRunForToolApprovals: vi.fn(async () => []),
  };
});
vi.mock("@/lib/thread-metadata", () => ({
  refreshThreadPresentationMetadata: vi.fn(async () => undefined),
}));
vi.mock("@/lib/thread-summary", () => ({
  refreshThreadSummary: vi.fn(async () => ({
    status: "unchanged",
    reason: "nothing_pending",
  })),
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
  loadApprovedOrgInstructions: vi.fn(async () => null),
  recordOrgInstructionConflict: vi.fn(async () => undefined),
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
vi.mock("@/lib/proposal-iterations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/proposal-iterations")>();
  return {
    ...actual,
    completeProposalIteration: vi.fn(async () => true),
    releaseProposalIteration: vi.fn(async () => true),
  };
});
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
import {
  loadStandingToolApprovalGrants,
  loadToolApprovalGrants,
  pauseRunForToolApprovals,
} from "@/lib/tool-approvals";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { createProactiveRunNotification } from "@/lib/notifications";
import { buildChatContextPack } from "@/lib/chat-context-pack";
import { buildTurnToolDiscovery } from "@/lib/tool-discovery";
import { buildTurnContext } from "@/lib/turn-context";
import { refreshThreadSummary } from "@/lib/thread-summary";
import { builtinToolsForChatRoute } from "@/lib/runtime-builtin-tools";
import { createArtifactsFromAssistantMessage } from "@/lib/workspace-artifacts";
import { createDraftAppVersionsForThreadArtifacts } from "@/lib/apps";
import { enqueueMemoryCapture } from "@/lib/memory-capture";
import { persistProviderTraceCapture } from "@/lib/run-trace";
import {
  abortChatWorkerRuntime,
  chatWorkerAbortReason,
} from "@/lib/chat-worker-abort";
import {
  completeProposalIteration,
  releaseProposalIteration,
  type StoredProposalIteration,
} from "@/lib/proposal-iterations";

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

function fakeRuntime(
  captured: { turnInput?: Record<string, unknown> },
  text = "Hello",
): AgentRuntime {
  return {
    name: "bedrock",
    runTurn: async function* (input: Record<string, unknown>) {
      captured.turnInput = input;
      await (
        input.onRunStarted as (m: Record<string, unknown>) => Promise<void>
      )?.({ providerRunId: "pr-1" });
      yield { type: "text-delta", delta: text };
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

const runBudget: RunBudgetState = {
  envelope: {
    schema: RUN_BUDGET_SCHEMA,
    version: 1,
    governingLayer: "organization",
    limits: {
      tokens: 400_000,
      usd: 4,
      wallClockMs: 900_000,
      toolIterations: 8,
    },
  },
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
    runBudget,
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
    runBudget,
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

const proposalIteration: StoredProposalIteration = {
  kind: "artifact",
  runId: "run-1",
  sourceArtifactId: "artifact-v1",
  sourceArtifactGroupId: "weekly-report",
  sourceRunId: "source-run",
  sourceTriggerType: "scheduled",
  sourceThreadId: "thread-1",
  feedbackMessageId: "user-msg-1",
  requestedAt: "2026-07-23T12:00:00.000Z",
  requestedByUserId: "user-1",
};

function proposalWorkerInput() {
  const fixture = workerInput();
  fixture.run.triggerType = "proposal_iteration";
  if (fixture.input.lane.kind !== "worker") {
    throw new Error("Expected worker lane");
  }
  fixture.input.lane.storedInputs = {
    prompt: "Iterate on weekly-report.md: Add a risks section.",
    threadId: "thread-1",
    proposalIteration,
  };
  return fixture;
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

  it.each(["scheduled", "github_event"])(
    "denies writes without loading approvals or pausing for a %s run",
    async (triggerType) => {
      const fixture = workerInput();
      fixture.run.triggerType = triggerType;
      fixture.run.skillId = "skill-1";
      if (fixture.input.lane.kind !== "worker") {
        throw new Error("Expected worker");
      }
      fixture.input.lane.storedInputs = {
        ...fixture.input.lane.storedInputs,
        autonomyPreset: "interactive",
      };

      await executeChatTurn(fixture.input);

      expect(fixture.captured.turnInput?.toolApprovalMode).toBe(
        "deny_unattended",
      );
      expect(buildChatContextPack).toHaveBeenCalledWith(
        expect.objectContaining({ autonomyPreset: "unattended" }),
      );
      expect(
        fixture.state.runUpdates.find(
          (update) =>
            (update.inputs as Record<string, unknown> | undefined)
              ?.autonomyPreset === "unattended",
        ),
      ).toBeDefined();
      expect(loadToolApprovalGrants).not.toHaveBeenCalled();
      expect(loadStandingToolApprovalGrants).not.toHaveBeenCalled();
      expect(pauseRunForToolApprovals).not.toHaveBeenCalled();
    },
  );

  it("reports skipped unattended writes while keeping the run successful", async () => {
    vi.mocked(createToolEventAccumulator).mockReturnValueOnce({
      recordCall: vi.fn(),
      recordResult: vi.fn(),
      calls: () => [],
      results: () => [
        {
          toolCallId: "call-skipped",
          name: "gmail__draft_email",
          provider: "gmail",
          toolName: "draft_email",
          output: { error: "tool_approval_unattended_denied" },
          isError: true,
          completedAt: "2026-08-16T12:00:00.000Z",
        },
      ],
    });
    const fixture = workerInput();
    fixture.run.triggerType = "scheduled";
    fixture.run.skillId = "skill-1";

    await executeChatTurn(fixture.input);

    const terminal = fixture.state.runUpdates.find(
      (update) => update.status === "succeeded",
    );
    expect(terminal?.outputs).toMatchObject({
      autonomy: {
        preset: "unattended",
        skippedWriteCount: 1,
        reason: "denied_unattended",
      },
    });
    expect(appendRunEventBestEffort).toHaveBeenCalledWith(
      "chat-run-event-error",
      expect.objectContaining({
        db: fixture.input.db,
        runId: "run-1",
        eventType: "autonomy_writes_skipped",
        status: "info",
        metadata: {
          preset: "unattended",
          skippedWriteCount: 1,
          reason: "denied_unattended",
        },
      }),
    );
    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      fixture.input.db,
      fixture.run,
      "succeeded",
      "thread-1",
      { hasProposal: false, skippedWriteCount: 1 },
    );
  });

  it("loads endpoint-bound Skill grants for an attended manual run", async () => {
    const fixture = workerInput();
    fixture.run.triggerType = "skill";
    fixture.run.skillId = "skill-1";

    await executeChatTurn(fixture.input);

    expect(fixture.captured.turnInput?.toolApprovalMode).toBe("request");
    expect(loadStandingToolApprovalGrants).toHaveBeenCalledWith({
      db: fixture.input.db,
      userId: "user-1",
      skillId: "skill-1",
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

describe("executeChatTurn — interactive tool approvals (#410)", () => {
  it("persists a redacted pause and emits a durable inline approval card", async () => {
    const calls = [
      {
        id: "call-approval",
        name: "gmail__draft_email",
        provider: "gmail",
        toolName: "draft_email",
        input: { body: "[REDACTED]" },
        startedAt: "2026-08-15T12:00:00.000Z",
      },
    ];
    vi.mocked(createToolEventAccumulator).mockReturnValueOnce({
      recordCall: vi.fn(),
      recordResult: vi.fn(),
      calls: () => calls,
      results: () => [],
    });
    const approval = {
      id: "00000000-0000-4000-8000-000000000410",
      batchId: "00000000-0000-4000-8000-000000000411",
      toolCallId: "call-approval",
      toolName: "gmail__draft_email",
      provider: "gmail",
      nativeToolName: "draft_email",
      redactedInput: { body: "[REDACTED]" },
      status: "pending" as const,
        requestedAt: "2026-08-15T12:00:00.000Z",
        expiresAt: "2026-08-16T12:00:00.000Z",
    };
    vi.mocked(pauseRunForToolApprovals).mockResolvedValueOnce([approval]);
    const { input, sent, state } = inlineInput();
    input.runtime = {
      name: "agentcore",
      runTurn: async function* () {
        yield {
          type: "tool-call",
          call: {
            id: "call-approval",
            name: "gmail__draft_email",
            input: { body: "secret draft body" },
          },
        };
        yield {
          type: "tool-approval-required",
          requests: [
            {
              schema: "comparative.tool-approval-request.v1",
              toolCallId: "call-approval",
              toolName: "gmail__draft_email",
              fingerprint: "a".repeat(64),
            },
          ],
        };
        yield {
          type: "budget",
          receipt: {
            schema: "comparative.run-budget-receipt.v1",
            version: 1,
            governingLayer: "organization",
            limits: runBudget.envelope.limits,
            consumed: {
              tokens: 18,
              usd: 0.001,
              wallClockMs: 125,
              toolIterations: 0,
            },
            partial: false,
          },
        };
        yield {
          type: "usage",
          tokensIn: 11,
          tokensOut: 7,
          inputTokens: 11,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
        };
        yield { type: "done" };
      },
    } as unknown as AgentRuntime;

    await executeChatTurn(input);

    expect(pauseRunForToolApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        userId: "user-1",
        calls,
        requests: [
          expect.objectContaining({
            toolCallId: "call-approval",
            fingerprint: "a".repeat(64),
          }),
        ],
      }),
    );
    expect(sent).toContainEqual({
      type: "tool-approval-required",
      requests: [approval],
    });
    expect(sent).toContainEqual({
      type: "guardrail-receipt",
      receipt: expect.objectContaining({
        schema: "comparative.guardrails.v1",
        runId: "run-1",
        actions: [
          expect.objectContaining({
            action: "draft_email",
            state: "approval_required",
            governingLayer: "action",
            approval: expect.objectContaining({
              resourceScope: "exact_request",
              expiresAt: approval.expiresAt,
            }),
          }),
        ],
      }),
    });
    expect(sent).toContainEqual({
      type: "done",
      stopReason: "approval_required",
    });
    expect(
      state.inserts.find((insert) => insert.table === chatMessages),
    ).toBeUndefined();
    expect(state.runOutputs?.guardrails).toMatchObject({
      schema: "comparative.guardrails.v1",
      actions: [expect.objectContaining({ state: "approval_required" })],
      budget: {
        consumed: expect.objectContaining({ tokens: 18 }),
        partial: false,
      },
    });
    expect(state.runOutputs?.budgetReceipt).toMatchObject({
      consumed: expect.objectContaining({ tokens: 18 }),
      partial: false,
    });
    expect(JSON.stringify(sent)).not.toContain("secret draft body");
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
    expect(terminal?.outputs).toMatchObject({
      guardrails: {
        schema: "comparative.guardrails.v1",
        runId: "run-1",
        autonomy: { preset: "interactive" },
      },
    });

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
      guardrails: expect.objectContaining({
        schema: "comparative.guardrails.v1",
        runId: "run-1",
      }),
    });

    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).toContain("context_pack_assembled");
    expect(eventTypes).toContain("inline_runtime_started");
    expect(eventTypes).toContain("run_completed");
  });

  it("persists one authoritative partial budget receipt and streams its guardrail projection", async () => {
    const runtime = {
      name: "bedrock",
      runTurn: async function* () {
        yield { type: "text-delta", delta: "Partial result." };
        yield {
          type: "budget",
          receipt: {
            schema: "comparative.run-budget-receipt.v1",
            version: 1,
            governingLayer: "organization",
            limits: runBudget.envelope.limits,
            consumed: {
              tokens: 400_000,
              usd: 3.25,
              wallClockMs: 2_000,
              toolIterations: 2,
            },
            reached: "tokens",
            partial: true,
          },
        };
        yield { type: "usage", tokensIn: 399_000, tokensOut: 1_000 };
        yield { type: "done" };
      },
    } as unknown as AgentRuntime;
    const { input, sent, state } = inlineInput({ runtime });

    await executeChatTurn(input);

    expect(
      state.runUpdates.find((update) => update.status === "succeeded")?.outputs,
    ).toMatchObject({
      budgetReceipt: {
        reached: "tokens",
        partial: true,
        consumed: expect.objectContaining({ tokens: 400_000 }),
      },
      guardrails: {
        budget: {
          reached: "tokens",
          partial: true,
          consumed: expect.objectContaining({ tokens: 400_000 }),
        },
      },
    });
    expect(sent).toContainEqual({
      type: "guardrail-receipt",
      receipt: expect.objectContaining({
        budget: expect.objectContaining({ reached: "tokens", partial: true }),
      }),
    });
    expect(vi.mocked(appendRunEventBestEffort)).toHaveBeenCalledWith(
      "chat-inline-event-error",
      expect.objectContaining({
        eventType: "run_budget_measured",
        status: "info",
        metadata: expect.objectContaining({
          budget: expect.objectContaining({ reached: "tokens", partial: true }),
        }),
      }),
    );
  });

  it("#848: a budget stop succeeds with a partial receipt and a ledger event naming the dimension", async () => {
    // The loop's pre-invocation block sequence (loop.ts): notice text,
    // partial receipt, cumulative usage, done — and no `error` event.
    const runtime = {
      name: "bedrock",
      runTurn: async function* () {
        yield { type: "text-delta", delta: "Stopped: reached the token budget." };
        yield {
          type: "budget",
          receipt: {
            schema: "comparative.run-budget-receipt.v1",
            version: 1,
            governingLayer: "organization",
            limits: runBudget.envelope.limits,
            consumed: {
              tokens: 400_000,
              usd: 3.25,
              wallClockMs: 2_000,
              toolIterations: 2,
            },
            reached: "tokens",
            partial: true,
          },
        };
        yield { type: "usage", tokensIn: 399_000, tokensOut: 1_000 };
        yield { type: "done" };
      },
    } as unknown as AgentRuntime;
    const { input, state } = inlineInput({ runtime });

    await executeChatTurn(input);

    expect(
      state.runUpdates.find((update) => update.status === "failed"),
    ).toBeUndefined();
    expect(
      state.runUpdates.find((update) => update.status === "succeeded")?.outputs,
    ).toMatchObject({
      budgetReceipt: { partial: true, reached: "tokens" },
    });
    expect(vi.mocked(appendRunEventBestEffort)).toHaveBeenCalledWith(
      "chat-inline-event-error",
      expect.objectContaining({
        eventType: "run_completed",
        status: "succeeded",
        label: expect.stringContaining("partial"),
        metadata: expect.objectContaining({
          budget: { partial: true, reached: "tokens" },
        }),
      }),
    );
  });

  it("#848: a run that fails after usage persists a receipt that agrees with that usage", async () => {
    const runtime = {
      name: "bedrock",
      runTurn: async function* () {
        yield { type: "text-delta", delta: "partial" };
        yield { type: "usage", tokensIn: 11, tokensOut: 7 };
        yield { type: "error", message: "provider exploded" };
      },
    } as unknown as AgentRuntime;
    const { input, state } = inlineInput({ runtime });

    await executeChatTurn(input);

    const outputs = state.runUpdates.find(
      (update) => update.status === "failed",
    )?.outputs as { usage: TokenUsage; budgetReceipt: RunBudgetReceipt };
    expect(outputs.usage).toMatchObject({ tokensIn: 11, tokensOut: 7 });
    expect(outputs.budgetReceipt.partial).toBe(false);
    expect(outputs.budgetReceipt.consumed.tokens).toBe(
      outputs.usage.tokensIn + outputs.usage.tokensOut,
    );
    expect(outputs.budgetReceipt.consumed.usd).toBeCloseTo(
      estimateUsageCostUsd("sonnet-4-6", outputs.usage),
      12,
    );
  });

  it("#848: an aborted stream persists an accurate receipt that seeds approval resume", async () => {
    const { input, state } = workerInput();
    let markUsageConsumed: (() => void) | undefined;
    const usageConsumed = new Promise<void>((resolve) => {
      markUsageConsumed = resolve;
    });
    input.runtime = {
      name: "bedrock",
      runTurn: async function* (turnInput: Record<string, unknown>) {
        const signal = turnInput.signal as AbortSignal;
        yield { type: "text-delta", delta: "partial" };
        yield { type: "usage", tokensIn: 11, tokensOut: 7 };
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("The operation was aborted.");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
          markUsageConsumed?.();
        });
      },
    } as unknown as AgentRuntime;

    const execution = executeChatTurn(input);
    await usageConsumed;
    abortChatWorkerRuntime(input.runtimeAbort, "timeout");
    await execution;

    const outputs = state.runUpdates.find(
      (update) => update.status === "failed",
    )?.outputs as { usage: TokenUsage; budgetReceipt: RunBudgetReceipt };
    expect(outputs.budgetReceipt.partial).toBe(false);
    expect(outputs.budgetReceipt.consumed.tokens).toBe(
      outputs.usage.tokensIn + outputs.usage.tokensOut,
    );
    expect(outputs.budgetReceipt.consumed.usd).toBeCloseTo(
      estimateUsageCostUsd("sonnet-4-6", outputs.usage),
      12,
    );
    expect(
      resolveStoredRunBudget({
        stored: runBudget,
        priorReceipt: outputs.budgetReceipt,
        lane: "tool-local",
        triggerType: "chat",
      }).consumed,
    ).toEqual(outputs.budgetReceipt.consumed);
  });

  it("#848: the worker telemetry write carries the delta-recorded receipt, not zeros", async () => {
    const { input, state } = workerInput();
    await executeChatTurn(input);

    const telemetryUpdate = state.runUpdates.find(
      (update) =>
        (update.outputs as { lifecycle?: string } | undefined)?.lifecycle ===
        "provider_running",
    );
    expect(telemetryUpdate?.outputs).toMatchObject({
      usage: { tokensIn: 11, tokensOut: 7 },
      budgetReceipt: {
        partial: false,
        consumed: expect.objectContaining({ tokens: 18 }),
      },
    });
  });

  it("#713: a degraded provider mount is recorded on the run but does not fail it", async () => {
    const runtime = {
      name: "bedrock",
      runTurn: async function* (turnInput: Record<string, unknown>) {
        await (
          turnInput.onRunStarted as
            | ((metadata: Record<string, unknown>) => Promise<void>)
            | undefined
        )?.({ providerRunId: "pr-713" });
        yield {
          type: "error",
          degradedProvider: "google",
          message:
            "BedrockRuntime: MCP connection failed for google — continuing without its tools (invalid_grant)",
        };
        yield { type: "text-delta", delta: "Hello" };
        yield { type: "usage", tokensIn: 11, tokensOut: 7 };
        yield { type: "done" };
      },
    } as unknown as AgentRuntime;
    const { input, sent, state } = inlineInput({ runtime });
    await executeChatTurn(input);

    // The run succeeded — degraded, not failed — and the client stream never
    // saw an error (a streamed error would make the client throw on done).
    expect(
      state.runUpdates.find((update) => update.status === "succeeded"),
    ).toBeDefined();
    expect(
      state.runUpdates.find((update) => update.status === "failed"),
    ).toBeUndefined();
    const types = sent.map((event) => event.type);
    expect(types).toContain("persisted");
    expect(types).toContain("done");
    expect(types).not.toContain("failed");
    expect(types).not.toContain("error");

    // No silent degradation: the mount failure is on the run's receipts.
    const degradedEvents = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event)
      .filter((event) => event.eventType === "mcp_provider_mount_failed");
    expect(degradedEvents).toHaveLength(1);
    expect(degradedEvents[0]).toMatchObject({
      provider: "google",
      status: "failed",
      error:
        "BedrockRuntime: MCP connection failed for google — continuing without its tools (invalid_grant)",
    });
  });

  it("records and persists the actual model after pre-stream failover", async () => {
    const attempted: string[] = [];
    const runtime = {
      name: "bedrock",
      runTurn: async function* (turnInput: Record<string, unknown>) {
        const candidate = String(turnInput.modelId);
        attempted.push(candidate);
        await (
          turnInput.onRunStarted as
            | ((metadata: Record<string, unknown>) => Promise<void>)
            | undefined
        )?.({ providerRunId: `provider-${candidate}` });
        if (candidate === "sonnet-4-6") {
          yield {
            type: "error",
            message: "ThrottlingException: capacity unavailable",
          };
          return;
        }
        yield { type: "text-delta", delta: "Fallback answer" };
        yield { type: "usage", tokensIn: 11, tokensOut: 7 };
        yield { type: "done" };
      },
    } as unknown as AgentRuntime;
    const { input, sent, state } = inlineInput({
      runtime,
      modelCandidates: ["sonnet-4-6", "haiku-4-5"],
    });

    await executeChatTurn(input);

    expect(attempted).toEqual(["sonnet-4-6", "haiku-4-5"]);
    expect(
      state.inserts.find((insert) => insert.table === chatMessages)?.values,
    ).toMatchObject({
      content: "Fallback answer",
      modelId: "haiku-4-5",
    });
    expect(
      state.runUpdates.find((update) => update.modelId === "haiku-4-5"),
    ).toBeDefined();
    expect(
      state.runUpdates.find((update) => update.status === "succeeded")?.outputs,
    ).toMatchObject({
      modelId: "haiku-4-5",
      providerModelId:
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      modelSelection: {
        modelId: "haiku-4-5",
        reason: "availability_failover",
        failover: {
          fromModelId: "sonnet-4-6",
          attempt: 1,
        },
      },
    });
    const modelEvents = sent.filter((event) => event.type === "model");
    expect(modelEvents.at(-1)).toMatchObject({
      type: "model",
      modelId: "haiku-4-5",
      providerModelId:
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(
      vi
        .mocked(appendRunEventBestEffort)
        .mock.calls.map(([, event]) => event.eventType),
    ).toContain("model_failover");
    expect(
      state.inserts
        .filter((insert) => insert.table === auditLog)
        .flatMap((insert) =>
          Array.isArray(insert.values) ? insert.values : [insert.values],
        ),
    ).toContainEqual(
      expect.objectContaining({
        actionType: "model_failover",
        status: "succeeded",
        input: expect.objectContaining({ modelId: "sonnet-4-6" }),
        output: expect.objectContaining({ modelId: "haiku-4-5" }),
      }),
    );
  });

  it("does not start a replacement model after the active-run fence is lost", async () => {
    const attempted: string[] = [];
    const runtime = {
      name: "bedrock",
      runTurn: async function* (turnInput: Record<string, unknown>) {
        attempted.push(String(turnInput.modelId));
        yield {
          type: "error",
          message: "ThrottlingException",
        };
      },
    } as unknown as AgentRuntime;
    const { input, sent, state } = inlineInput({
      runtime,
      modelCandidates: ["sonnet-4-6", "haiku-4-5"],
    });
    state.updateReturning = [];

    await executeChatTurn(input);

    expect(attempted).toEqual(["sonnet-4-6"]);
    expect(
      sent.filter((event) => event.type === "model").map((event) => event.modelId),
    ).toEqual(["sonnet-4-6"]);
    expect(
      state.inserts
        .filter((insert) => insert.table === auditLog)
        .flatMap((insert) =>
          Array.isArray(insert.values) ? insert.values : [insert.values],
        )
        .some(
          (row) =>
            (row as Record<string, unknown>).actionType === "model_failover",
        ),
    ).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      type: "failed",
      stopReason: "runtime_error",
    });
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
          // #647: the user-turn creation-intent classification reaches the
          // persistence seam on the worker lane too.
          documentCreationIntent: false,
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

  it("supersedes the source only after a replacement artifact is minted", async () => {
    const replacement = {
      id: "artifact-v2",
      title: "Weekly report",
      filename: "weekly-report.md",
      kind: "document",
      mimeType: "text/markdown",
      sizeBytes: 160,
      source: "assistant",
      threadId: "thread-1",
      chatMessageId: "assistant-msg-1",
      runId: "run-1",
      artifactGroupId: "weekly-report",
      versionNumber: 2,
      supersedesArtifactId: "artifact-v1",
      versionSummary: "Added a risks section.",
      metadata: null,
      createdAt: "2026-07-23T12:05:00.000Z",
      previewUrl: "/workspace/artifacts/artifact-v2",
      downloadUrl: "/api/workspace/artifacts/artifact-v2/download",
    };
    vi.mocked(createArtifactsFromAssistantMessage).mockResolvedValueOnce([
      replacement,
    ]);
    const fixture = proposalWorkerInput();

    await executeChatTurn(fixture.input);

    expect(createArtifactsFromAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({
          runId: "run-1",
          triggerType: "scheduled",
          iterationOf: expect.objectContaining({
            sourceArtifactId: "artifact-v1",
            feedbackMessageId: "user-msg-1",
          }),
        }),
      }),
    );
    expect(completeProposalIteration).toHaveBeenCalledWith(
      expect.objectContaining({
        iteration: proposalIteration,
        replacementArtifact: replacement,
        expectedWorkerId: "w-test",
      }),
    );
    expect(releaseProposalIteration).not.toHaveBeenCalled();
    expect(
      fixture.state.runUpdates.find((update) => update.status === "succeeded"),
    ).toBeDefined();
    expect(
      vi
        .mocked(appendRunEventBestEffort)
        .mock.calls.map(([, event]) => event.eventType),
    ).toContain("proposal_iteration_completed");
  });

  it("restores the source proposal and fails the run when no replacement is minted", async () => {
    const fixture = proposalWorkerInput();

    await executeChatTurn(fixture.input);

    expect(completeProposalIteration).not.toHaveBeenCalled();
    expect(releaseProposalIteration).toHaveBeenCalledWith(
      expect.objectContaining({
        iteration: proposalIteration,
        error: expect.stringContaining("without creating a replacement"),
        expectedWorkerId: "w-test",
        replacementArtifactIds: [],
      }),
    );
    expect(
      fixture.state.runUpdates.find((update) => update.status === "failed"),
    ).toMatchObject({
      error: expect.stringContaining("without creating a replacement"),
    });
    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      fixture.input.db,
      fixture.run,
      "failed",
      "thread-1",
      { hasProposal: false },
    );
  });

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

  it("does not claim an app version was created when the artifact already had one", async () => {
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
      created: [],
      rejected: [],
      summaries: [
        {
          id: "version-4",
          appId: "app-1",
          appName: "Dashboard",
          appSlug: "dashboard",
          artifactId: "artifact-app",
          versionNumber: 4,
          status: "deployed",
          canDeploy: false,
          previewUrl: "/api/apps/app-1/versions/version-4/content",
          liveUrl: "/apps/dashboard",
        },
      ],
    });
    const { input } = inlineInput();

    await executeChatTurn(input);

    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).not.toContain("app_draft_validation_completed");
    expect(eventTypes).not.toContain("app_draft_versions_created");
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
          abortReason: "canceled",
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
          abortReason: "canceled",
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
    abortChatWorkerRuntime(input.runtimeAbort, "timeout");
    await execution;

    expect(chatWorkerAbortReason(input.runtimeAbort.signal)).toBe("timeout");
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
    expect(vi.mocked(persistProviderTraceCapture)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        metadata: { abortReason: "timeout" },
      }),
    );
    expect(vi.mocked(appendRunEventBestEffort)).toHaveBeenCalledWith(
      "chat-run-event-error",
      expect.objectContaining({
        eventType: "run_failed",
        metadata: expect.objectContaining({ abortReason: "timeout" }),
      }),
    );
  });

  it("persists an honest shutdown error when the service aborts a blocked stream", async () => {
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
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("The operation was aborted.");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
          markStreamStarted?.();
        });
      },
    } as unknown as AgentRuntime;

    const execution = executeChatTurn(input);
    await streamStarted;
    abortChatWorkerRuntime(input.runtimeAbort, "shutdown");
    await execution;

    expect(state.runUpdates).toContainEqual(
      expect.objectContaining({
        status: "failed",
        error:
          "Background worker stopped because the service is shutting down.",
      }),
    );
    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      input.db,
      expect.anything(),
      "failed",
      "thread-1",
      { hasProposal: false },
    );
    expect(vi.mocked(appendRunEventBestEffort)).toHaveBeenCalledWith(
      "chat-run-event-error",
      expect.objectContaining({
        eventType: "run_failed",
        metadata: expect.objectContaining({ abortReason: "shutdown" }),
      }),
    );
  });

  it("records lease loss without letting the stale worker write a terminal state", async () => {
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
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("The operation was aborted.");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
          markStreamStarted?.();
        });
      },
    } as unknown as AgentRuntime;

    const execution = executeChatTurn(input);
    await streamStarted;
    abortChatWorkerRuntime(input.runtimeAbort, "lease_lost");
    await execution;

    expect(state.runUpdates).not.toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(createProactiveRunNotification).not.toHaveBeenCalled();
    expect(vi.mocked(persistProviderTraceCapture)).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        metadata: { abortReason: "lease_lost" },
      }),
    );
    expect(vi.mocked(appendRunEventBestEffort)).toHaveBeenCalledWith(
      "chat-run-event-error",
      expect.objectContaining({
        eventType: "worker_stopped_after_lease_loss",
        status: "info",
        metadata: expect.objectContaining({
          abortReason: "lease_lost",
          workerId: "w-test",
        }),
      }),
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

describe("executeChatTurn — literal output contract (#652/#644)", () => {
  it("answers a pure echo demand deterministically without invoking the model", async () => {
    const { input, sent, state, captured } = inlineInput({
      prompt: 'Reply exactly with "CBX-7745-TANGO"',
    });

    await executeChatTurn(input);

    // The seam that failed in #644: the model was asked to echo and refused.
    // A pure echo never reaches the model at all.
    expect(captured.turnInput).toBeUndefined();
    expect(
      state.inserts.find((insert) => insert.table === chatMessages)?.values,
    ).toMatchObject({ role: "assistant", content: "CBX-7745-TANGO" });
    expect(sent.find((event) => event.type === "text-delta")).toMatchObject({
      delta: "CBX-7745-TANGO",
    });
    expect(
      state.runUpdates.find((update) => update.status === "succeeded"),
    ).toMatchObject({ error: null });
    const eventTypes = vi
      .mocked(appendRunEventBestEffort)
      .mock.calls.map(([, event]) => event.eventType);
    expect(eventTypes).toContain("exact_output_fast_path");
    expect(eventTypes).not.toContain("provider_run_started");
    // The turn still succeeds normally, so memory capture stays untouched.
    expect(enqueueMemoryCapture).toHaveBeenCalledTimes(1);
  });

  it("routes a compound message to the model even when it contains an echo demand", async () => {
    const { input, captured } = inlineInput({
      prompt: "reply exactly ACK and also summarize the doc",
    });

    await executeChatTurn(input);

    expect(captured.turnInput).toBeDefined();
  });

  it("keeps the fast path off when the turn carries an attachment", async () => {
    const { input, captured } = inlineInput({
      prompt: 'Reply exactly with "CBX-7745-TANGO"',
      uploadedFiles: [{ name: "notes.txt", sizeBytes: 10 }],
    });

    await executeChatTurn(input);

    expect(captured.turnInput).toBeDefined();
  });

  it("runs the fast path through the shared worker pipeline too", async () => {
    const { input, state, captured } = workerInput({
      prompt: "Reply exactly: ACK-7",
    });

    await executeChatTurn(input);

    expect(captured.turnInput).toBeUndefined();
    expect(
      state.inserts.find((insert) => insert.table === chatMessages)?.values,
    ).toMatchObject({ content: "ACK-7" });
    expect(
      state.runUpdates.find((update) => update.status === "succeeded")?.outputs,
    ).toMatchObject({ assistantText: "ACK-7" });
    expect(createProactiveRunNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "succeeded",
      "thread-1",
      expect.anything(),
    );
  });

  it("reduces a prose-wrapped literal to the demanded text before persistence", async () => {
    const fixture = inlineInput({
      prompt: "Remember my favorite color is teal, then reply exactly: ACK-7",
    });
    fixture.input.runtime = fakeRuntime(
      fixture.captured,
      "Noted! Here you go: ACK-7",
    );

    await executeChatTurn(fixture.input);

    // The model ran (compound message)…
    expect(fixture.captured.turnInput).toBeDefined();
    // …but the persisted answer is exactly the demanded literal.
    expect(
      fixture.state.inserts.find((insert) => insert.table === chatMessages)
        ?.values,
    ).toMatchObject({ content: "ACK-7" });
    const terminal = fixture.state.runUpdates.find(
      (update) => update.status === "succeeded",
    );
    expect(terminal?.outputs).toMatchObject({ assistantText: "ACK-7" });
    expect(terminal?.outputs).not.toHaveProperty("contractViolation");
    // The client streamed the wrapped text, so the persisted event must
    // carry the corrected final answer.
    expect(
      fixture.sent.find((event) => event.type === "persisted"),
    ).toMatchObject({ content: "ACK-7" });
    expect(
      vi
        .mocked(appendRunEventBestEffort)
        .mock.calls.map(([, event]) => event.eventType),
    ).toContain("exact_output_reduced");
  });

  it("never reduces away requested content on a compound content+marker message (review)", async () => {
    const summary =
      "Here's a summary of the document: it covers the Q3 migration plan, " +
      "the rollback strategy, and the sign-off checklist. Overall the " +
      "migration is done and the checklist has two open items remaining.";
    const fixture = inlineInput({
      prompt: "Summarize the doc. Reply exactly: done",
    });
    fixture.input.runtime = fakeRuntime(fixture.captured, summary);

    await executeChatTurn(fixture.input);

    const persisted = fixture.state.inserts.find(
      (insert) => insert.table === chatMessages,
    )?.values as { content?: string } | undefined;
    // The summary the user asked for survives the incidental "done" hit.
    expect(persisted?.content).toBe(summary);
    expect(
      vi
        .mocked(appendRunEventBestEffort)
        .mock.calls.map(([, event]) => event.eventType),
    ).not.toContain("exact_output_reduced");
    const terminal = fixture.state.runUpdates.find(
      (update) => update.status === "succeeded",
    );
    expect(terminal?.outputs).toMatchObject({ assistantText: summary });
    expect(terminal?.outputs).not.toHaveProperty("contractViolation");
  });

  it("flags a missing literal on the run outputs without rewriting the answer", async () => {
    const fixture = inlineInput({
      prompt: "Remember my favorite color is teal, then reply exactly: ACK-7",
    });
    fixture.input.runtime = fakeRuntime(
      fixture.captured,
      "I saved that preference for you.",
    );

    await executeChatTurn(fixture.input);

    // Never invent the literal — the generated answer persists as-is.
    expect(
      fixture.state.inserts.find((insert) => insert.table === chatMessages)
        ?.values,
    ).toMatchObject({ content: "I saved that preference for you." });
    const terminal = fixture.state.runUpdates.find(
      (update) => update.status === "succeeded",
    );
    expect(terminal?.outputs).toMatchObject({
      assistantText: "I saved that preference for you.",
      contractViolation: "literal_missing",
    });
    expect(
      fixture.sent.find((event) => event.type === "persisted"),
    ).not.toMatchObject({ content: expect.anything() });
    expect(
      vi
        .mocked(appendRunEventBestEffort)
        .mock.calls.map(([, event]) => event.eventType),
    ).toContain("exact_output_contract_violation");
  });

  it("leaves an exact answer and its outputs untouched", async () => {
    const fixture = inlineInput({
      prompt: "Remember my favorite color is teal, then reply exactly: ACK-7",
    });
    fixture.input.runtime = fakeRuntime(fixture.captured, "ACK-7");

    await executeChatTurn(fixture.input);

    const terminal = fixture.state.runUpdates.find(
      (update) => update.status === "succeeded",
    );
    expect(terminal?.outputs).toMatchObject({ assistantText: "ACK-7" });
    expect(terminal?.outputs).not.toHaveProperty("contractViolation");
    expect(
      fixture.sent.find((event) => event.type === "persisted"),
    ).not.toMatchObject({ content: expect.anything() });
  });
});

describe("executeChatTurn — rolling thread summary (#771)", () => {
  const storedSummary = JSON.stringify({
    schema: "thread-summary.v1",
    coveredThroughMessageId: "m-4",
    coveredMessageCount: 4,
    updatedAt: "2026-09-04T01:00:00.000Z",
    facts: ["Launch is planned for October."],
    openItems: [],
    decisions: [],
    references: [],
  });

  it("hands the stored summary to the turn context and the receipt, then refreshes it user-scoped after persistence", async () => {
    const { input } = inlineInput({
      thread: { id: "thread-1", summary: storedSummary } as unknown as ChatThread,
    });
    await executeChatTurn(input);

    expect(vi.mocked(buildTurnContext).mock.calls[0]?.[0]).toMatchObject({
      threadSummary: expect.objectContaining({
        coveredMessageCount: 4,
        facts: ["Launch is planned for October."],
      }),
    });
    expect(vi.mocked(buildChatContextPack).mock.calls[0]?.[0]).toMatchObject({
      threadSummary: expect.objectContaining({ coveredMessageCount: 4 }),
    });
    expect(refreshThreadSummary).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", threadId: "thread-1" }),
    );
  });

  it("passes no summary for a thread without one and still schedules the refresh on the worker lane", async () => {
    const { input } = workerInput();
    await executeChatTurn(input);

    expect(vi.mocked(buildTurnContext).mock.calls[0]?.[0]).toMatchObject({
      threadSummary: null,
    });
    expect(vi.mocked(buildChatContextPack).mock.calls[0]?.[0]).toMatchObject({
      threadSummary: null,
    });
    expect(refreshThreadSummary).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the summary when the turn fails", async () => {
    const { input } = inlineInput({ runtime: truncatedRuntime() });
    await executeChatTurn(input);
    expect(refreshThreadSummary).not.toHaveBeenCalled();
  });
});
