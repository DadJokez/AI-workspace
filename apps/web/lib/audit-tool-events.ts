import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";

export interface BuildToolAuditRowsInput {
  actorUserId: string;
  chatThreadId: string;
  chatMessageId: string;
  modelId: string;
  runtime: string;
  calls: readonly PersistedToolCall[];
  results: readonly PersistedToolResult[];
}

export interface ToolAuditRow {
  actorUserId: string;
  actionType: "mcp_tool_execution";
  status: "started" | "succeeded" | "failed";
  provider: string | null;
  toolName: string;
  toolCallId: string;
  chatThreadId: string;
  chatMessageId: string;
  input: Record<string, unknown> | null;
  output: unknown;
  error: string | null;
  metadata: {
    rawToolName?: string;
    modelId: string;
    runtime: string;
  };
  startedAt: Date | null;
  completedAt: Date | null;
}

export function buildToolAuditRows({
  actorUserId,
  chatThreadId,
  chatMessageId,
  modelId,
  runtime,
  calls,
  results,
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
        modelId,
        runtime,
        call,
        result,
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
        modelId,
        runtime,
        result,
      }),
    );
  }

  return rows;
}

function buildRow({
  actorUserId,
  chatThreadId,
  chatMessageId,
  modelId,
  runtime,
  call,
  result,
}: {
  actorUserId: string;
  chatThreadId: string;
  chatMessageId: string;
  modelId: string;
  runtime: string;
  call?: PersistedToolCall;
  result?: PersistedToolResult;
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
    chatThreadId,
    chatMessageId,
    input: call?.input ?? null,
    output: result?.isError ? null : (result?.output ?? null),
    error: result?.isError ? stringifyAuditError(result.output) : null,
    metadata: {
      ...(rawToolName ? { rawToolName } : {}),
      modelId,
      runtime,
    },
    startedAt: call ? new Date(call.startedAt) : null,
    completedAt: result ? new Date(result.completedAt) : null,
  };
}

function stringifyAuditError(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
