import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import {
  redactProviderToolError,
  redactProviderToolPayload,
} from "@/lib/tool-redaction";
import {
  observedPolicyDecision,
  toolActionKey,
  type ObservedPolicyDecision,
  type ToolActionLevel,
} from "@/lib/tool-policy";

export interface BuildToolAuditRowsInput {
  actorUserId: string;
  chatThreadId?: string | null;
  chatMessageId?: string | null;
  runId?: string | null;
  modelId: string;
  runtime: string;
  calls: readonly PersistedToolCall[];
  results: readonly PersistedToolResult[];
  /**
   * Catalog action per `provider__toolName` (#410 P1, observe mode). When
   * present, every row records what the tri-state policy WOULD have decided
   * — nothing is enforced yet. Absent (e.g. builtin web tools with no
   * catalog rows), the stamp is omitted rather than guessed.
   */
  toolActions?: Record<string, ToolActionLevel>;
}

export interface ToolAuditRow {
  actorUserId: string;
  actionType: "mcp_tool_execution";
  status: "started" | "succeeded" | "failed";
  provider: string | null;
  toolName: string;
  toolCallId: string;
  chatThreadId: string | null;
  chatMessageId: string | null;
  runId: string | null;
  input: Record<string, unknown> | null;
  output: unknown;
  error: string | null;
  metadata: {
    rawToolName?: string;
    modelId: string;
    runtime: string;
    policyDecision?: ObservedPolicyDecision;
  };
  startedAt: Date | null;
  completedAt: Date | null;
}

export function buildToolAuditRows({
  actorUserId,
  chatThreadId,
  chatMessageId,
  runId = null,
  modelId,
  runtime,
  calls,
  results,
  toolActions,
}: BuildToolAuditRowsInput): ToolAuditRow[] {
  const resultsById = new Map(results.map((result) => [result.toolCallId, result]));
  const callsById = new Map(calls.map((call) => [call.id, call]));
  const rows: ToolAuditRow[] = [];

  for (const call of calls) {
    const result = resultsById.get(call.id);
    rows.push(
      buildRow({
        actorUserId,
        chatThreadId,
        chatMessageId,
        runId,
        modelId,
        runtime,
        call,
        result,
        toolActions,
      }),
    );
  }

  for (const result of results) {
    if (callsById.has(result.toolCallId)) continue;
    rows.push(
      buildRow({
        actorUserId,
        chatThreadId,
        chatMessageId,
        runId,
        modelId,
        runtime,
        result,
        toolActions,
      }),
    );
  }

  return rows;
}

function buildRow({
  actorUserId,
  chatThreadId,
  chatMessageId,
  runId,
  modelId,
  runtime,
  call,
  result,
  toolActions,
}: {
  actorUserId: string;
  chatThreadId?: string | null;
  chatMessageId?: string | null;
  runId?: string | null;
  modelId: string;
  runtime: string;
  call?: PersistedToolCall;
  result?: PersistedToolResult;
  toolActions?: Record<string, ToolActionLevel>;
}): ToolAuditRow {
  const status = !result
    ? "started"
    : result.isError
      ? "failed"
      : "succeeded";
  const provider = call?.provider ?? result?.provider ?? null;
  const toolName = call?.toolName ?? result?.toolName ?? "unknown";
  const rawToolName = call?.name ?? result?.name;

  return {
    actorUserId,
    actionType: "mcp_tool_execution",
    status,
    provider,
    toolName,
    toolCallId: call?.id ?? result!.toolCallId,
    chatThreadId: chatThreadId ?? null,
    chatMessageId: chatMessageId ?? null,
    runId: runId ?? null,
    input: call
      ? (redactProviderToolPayload({
          provider,
          toolName,
          direction: "input",
          value: call.input,
        }) as Record<string, unknown>)
      : null,
    output: result?.isError
      ? null
      : (redactProviderToolPayload({
          provider,
          toolName,
          direction: "output",
          value: result?.output,
        }) ?? null),
    error: result?.isError
      ? redactProviderToolError(provider, result.output)
      : null,
    metadata: {
      ...(rawToolName ? { rawToolName } : {}),
      modelId,
      runtime,
      // #410 P1 observe mode: what the tri-state policy WOULD have decided.
      ...(toolActions && provider
        ? {
            policyDecision: observedPolicyDecision(
              toolActions[toolActionKey(provider, toolName)],
            ),
          }
        : {}),
    },
    startedAt: call ? new Date(call.startedAt) : null,
    completedAt: result ? new Date(result.completedAt) : null,
  };
}
