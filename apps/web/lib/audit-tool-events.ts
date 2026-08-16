import type { ToolPolicyAuditDecision } from "@ai-workspace/agent";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import { parseWebEgressDenial } from "@ai-workspace/agent/web-egress-policy";
import {
  redactProviderToolError,
  redactProviderToolPayload,
} from "@/lib/tool-redaction";
import {
  observedPolicyDecision,
  toolActionKey,
  type ObservedPolicyDecision,
  type ToolPolicyDecision,
} from "@/lib/tool-policy";
import type { AutonomyPresetName } from "@/lib/autonomy-presets";

export interface BuildToolAuditRowsInput {
  actorUserId: string;
  chatThreadId?: string | null;
  chatMessageId?: string | null;
  runId?: string | null;
  modelId: string;
  runtime: string;
  autonomyPreset?: AutonomyPresetName;
  calls: readonly PersistedToolCall[];
  results: readonly PersistedToolResult[];
  /**
   * Catalog policy per `provider__toolName` (#410). Current executor results
   * carry the actual decision; this map preserves observe-mode fallback for
   * started rows, old results, and rolling deployments. Built-in web tools use
   * their separate egress policy and keep this column null.
   */
  toolPolicyDecisions?: Record<string, ToolPolicyDecision>;
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
  policyDecision: ToolPolicyAuditDecision | null;
  metadata: {
    rawToolName?: string;
    approvalId?: string;
    modelId: string;
    runtime: string;
    autonomyPreset: AutonomyPresetName;
    webEgress?: {
      outcome: "allowed" | "denied";
      reason?: "denied_domain_policy";
      policy?: string;
      hostname?: string;
      matchedDomain?: string;
      fetchedHosts?: string[];
    };
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
  autonomyPreset = "interactive",
  calls,
  results,
  toolPolicyDecisions,
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
        autonomyPreset,
        call,
        result,
        toolPolicyDecisions,
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
        autonomyPreset,
        result,
        toolPolicyDecisions,
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
  autonomyPreset,
  call,
  result,
  toolPolicyDecisions,
}: {
  actorUserId: string;
  chatThreadId?: string | null;
  chatMessageId?: string | null;
  runId?: string | null;
  modelId: string;
  runtime: string;
  autonomyPreset: AutonomyPresetName;
  call?: PersistedToolCall;
  result?: PersistedToolResult;
  toolPolicyDecisions?: Record<string, ToolPolicyDecision>;
}): ToolAuditRow {
  const status = !result
    ? "started"
    : result.isError
      ? "failed"
      : "succeeded";
  const provider = call?.provider ?? result?.provider ?? null;
  const toolName = call?.toolName ?? result?.toolName ?? "unknown";
  const rawToolName = call?.name ?? result?.name;
  const webEgress = buildWebEgressAuditMetadata(provider, toolName, result);

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
    policyDecision:
      result?.policyDecision ??
      observedCatalogPolicyDecision({
        provider,
        toolName,
        toolPolicyDecisions,
      }),
    metadata: {
      ...(rawToolName ? { rawToolName } : {}),
      ...(result?.approvalId ? { approvalId: result.approvalId } : {}),
      modelId,
      runtime,
      autonomyPreset,
      ...(webEgress ? { webEgress } : {}),
    },
    startedAt: call ? new Date(call.startedAt) : null,
    completedAt: result ? new Date(result.completedAt) : null,
  };
}

function observedCatalogPolicyDecision({
  provider,
  toolName,
  toolPolicyDecisions,
}: {
  provider: string | null;
  toolName: string;
  toolPolicyDecisions?: Record<string, ToolPolicyDecision>;
}): ObservedPolicyDecision | null {
  return toolPolicyDecisions && provider && provider !== "web"
    ? observedPolicyDecision(
        toolPolicyDecisions[toolActionKey(provider, toolName)],
      )
    : null;
}

function buildWebEgressAuditMetadata(
  provider: string | null,
  toolName: string,
  result?: PersistedToolResult,
): ToolAuditRow["metadata"]["webEgress"] | undefined {
  if (provider !== "web" || !result) return undefined;

  if (result.isError) {
    const denial = parseWebEgressDenial(result.output);
    return denial
      ? {
          outcome: "denied",
          reason: denial.reason,
          policy: denial.policy,
          hostname: denial.hostname,
          matchedDomain: denial.matchedDomain,
        }
      : undefined;
  }
  if (toolName !== "fetch_url") return undefined;
  if (
    typeof result.output !== "object" ||
    result.output === null ||
    Array.isArray(result.output)
  ) {
    return undefined;
  }
  const hosts = (result.output as { fetchedHosts?: unknown }).fetchedHosts;
  if (!Array.isArray(hosts)) return undefined;
  return {
    outcome: "allowed",
    fetchedHosts: hosts
      .filter((host): host is string => typeof host === "string")
      .slice(0, 10),
  };
}
