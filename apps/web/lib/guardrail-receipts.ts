import type { ToolApprovalGrant } from "@ai-workspace/agent";

import {
  AUTONOMY_PRESETS,
  type AutonomyPresetName,
} from "@/lib/autonomy-presets";
import type { ChatContextReceipt } from "@/lib/chat-context-pack";
import type { PersistedToolCall, PersistedToolResult } from "@/lib/tool-events";
import type { PublicToolApprovalRequest } from "@/lib/tool-approvals";

export const GUARDRAIL_RECEIPT_SCHEMA = "comparative.guardrails.v1" as const;

export type GuardrailGoverningLayer =
  | "organization"
  | "agent_skill"
  | "session"
  | "action"
  | "connection";

export type GuardrailProviderState =
  | "ready"
  | "not_connected"
  | "attestation_required"
  | "reconnect_required"
  | "execution_unavailable";

export type GuardrailActionState =
  | "allowed"
  | "approval_required"
  | "approved"
  | "denied"
  | "blocked"
  | "skipped";

export interface GuardrailApprovalScope {
  kind: "exact_call" | "skill_tool";
  provider: string | null;
  action: string;
  resourceScope: "exact_request" | "tool_authority";
  resourceLabel: string;
  expiresAt?: string;
  approvalId?: string;
}

export interface GuardrailProviderReceipt {
  provider: string;
  state: GuardrailProviderState;
  governingLayer: "connection" | "organization";
  reason: string;
  remediation?: "connect" | "attest" | "reconnect" | "contact_admin";
  mounted: boolean;
}

export interface GuardrailActionReceipt {
  toolCallId: string;
  provider: string | null;
  action: string;
  state: GuardrailActionState;
  governingLayer: GuardrailGoverningLayer;
  reason: string;
  outcome: "pending" | "succeeded" | "failed" | "not_run";
  approval?: GuardrailApprovalScope;
}

export interface GuardrailBudgetReceipt {
  governingLayer: GuardrailGoverningLayer;
  limits: {
    tokens?: number;
    usd?: number;
    wallClockMs?: number;
    toolIterations?: number;
  };
  consumed: {
    tokens?: number;
    usd?: number;
    wallClockMs?: number;
    toolIterations?: number;
  };
  reached?: "tokens" | "usd" | "wall_clock" | "tool_iterations";
  partial: boolean;
}

export interface GuardrailReceipt {
  schema: typeof GUARDRAIL_RECEIPT_SCHEMA;
  version: 1;
  generatedAt: string;
  runId: string;
  autonomy: {
    preset: AutonomyPresetName;
    label: string;
    governingLayer: "session";
    reason: string;
  };
  providers: GuardrailProviderReceipt[];
  actions: GuardrailActionReceipt[];
  budget?: GuardrailBudgetReceipt;
}

export interface BuildGuardrailReceiptInput {
  runId: string;
  autonomyPreset: AutonomyPresetName;
  contextReceipt?: ChatContextReceipt | null;
  requestedProviders?: readonly string[];
  toolCalls?: readonly PersistedToolCall[];
  toolResults?: readonly PersistedToolResult[];
  approvalRequests?: readonly PublicToolApprovalRequest[];
  approvalGrants?: readonly ToolApprovalGrant[];
  budget?: unknown;
  generatedAt?: Date;
}

/**
 * Projects trusted runtime state into one redacted public receipt. The browser
 * renders this value; it never re-resolves policy from prompts or tool input.
 */
export function buildGuardrailReceipt({
  runId,
  autonomyPreset,
  contextReceipt,
  requestedProviders = [],
  toolCalls = [],
  toolResults = [],
  approvalRequests = [],
  approvalGrants = [],
  budget,
  generatedAt = new Date(),
}: BuildGuardrailReceiptInput): GuardrailReceipt {
  const preset = AUTONOMY_PRESETS[autonomyPreset];
  const parsedBudget = parseGuardrailBudgetReceipt(budget);
  return {
    schema: GUARDRAIL_RECEIPT_SCHEMA,
    version: 1,
    generatedAt: generatedAt.toISOString(),
    runId,
    autonomy: {
      preset: autonomyPreset,
      label: preset.label,
      governingLayer: "session",
      reason: preset.description,
    },
    providers: buildProviderReceipts(contextReceipt, requestedProviders),
    actions: buildActionReceipts({
      toolCalls,
      toolResults,
      approvalRequests,
      approvalGrants,
    }),
    ...(parsedBudget ? { budget: parsedBudget } : {}),
  };
}

export function parseGuardrailReceipt(value: unknown): GuardrailReceipt | null {
  if (!isRecord(value)) return null;
  if (
    value.schema !== GUARDRAIL_RECEIPT_SCHEMA ||
    value.version !== 1 ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    typeof value.runId !== "string" ||
    !isRecord(value.autonomy) ||
    !isAutonomyPresetName(value.autonomy.preset) ||
    typeof value.autonomy.label !== "string" ||
    value.autonomy.governingLayer !== "session" ||
    typeof value.autonomy.reason !== "string" ||
    !Array.isArray(value.providers) ||
    !Array.isArray(value.actions)
  ) {
    return null;
  }

  const providers = value.providers.flatMap(parseProviderReceipt);
  const actions = value.actions.flatMap(parseActionReceipt);
  if (
    providers.length !== value.providers.length ||
    actions.length !== value.actions.length
  ) {
    return null;
  }
  const budget = parseGuardrailBudgetReceipt(value.budget);
  return {
    schema: GUARDRAIL_RECEIPT_SCHEMA,
    version: 1,
    generatedAt: value.generatedAt,
    runId: value.runId,
    autonomy: {
      preset: value.autonomy.preset,
      label: value.autonomy.label,
      governingLayer: "session",
      reason: value.autonomy.reason,
    },
    providers,
    actions,
    ...(budget ? { budget } : {}),
  };
}

function buildProviderReceipts(
  contextReceipt: ChatContextReceipt | null | undefined,
  requestedProviders: readonly string[],
): GuardrailProviderReceipt[] {
  const providerItems = contextReceipt?.tools.providers ?? [];
  const byProvider = new Map(
    providerItems.map((provider) => [provider.provider, provider]),
  );
  const providers = uniqueStrings([
    ...requestedProviders,
    ...providerItems.map((provider) => provider.provider),
  ]);

  return providers.map((provider) => {
    const item = byProvider.get(provider);
    if (!item?.connected) {
      return {
        provider,
        state: "not_connected",
        governingLayer: "connection",
        reason: `${provider} is not connected for this workspace.`,
        remediation: "connect",
        mounted: false,
      };
    }
    if (item.reconnectRequired) {
      return {
        provider,
        state: "reconnect_required",
        governingLayer: "connection",
        reason: `${provider} must be reconnected before its tools can run.`,
        remediation: "reconnect",
        mounted: false,
      };
    }
    if (item.executionUnavailable) {
      return {
        provider,
        state: "execution_unavailable",
        governingLayer: "organization",
        reason: `${provider} is connected, but tool execution is unavailable in this deployment.`,
        remediation: "contact_admin",
        mounted: false,
      };
    }
    if (!item.approved || item.pendingApproval) {
      return {
        provider,
        state: "attestation_required",
        governingLayer: "connection",
        reason: `${provider} is connected but has not been approved for agent use.`,
        remediation: "attest",
        mounted: false,
      };
    }
    return {
      provider,
      state: "ready",
      governingLayer: "connection",
      reason: item.mounted
        ? `${provider} was available to this run.`
        : `${provider} is approved and available when needed.`,
      mounted: item.mounted,
    };
  });
}

function buildActionReceipts({
  toolCalls,
  toolResults,
  approvalRequests,
  approvalGrants,
}: {
  toolCalls: readonly PersistedToolCall[];
  toolResults: readonly PersistedToolResult[];
  approvalRequests: readonly PublicToolApprovalRequest[];
  approvalGrants: readonly ToolApprovalGrant[];
}): GuardrailActionReceipt[] {
  const resultsByCallId = new Map(
    toolResults.map((result) => [result.toolCallId, result]),
  );
  const requestsByCallId = new Map(
    approvalRequests.map((request) => [request.toolCallId, request]),
  );
  const requestsById = new Map(
    approvalRequests.map((request) => [request.id, request]),
  );
  const grantsById = new Map(
    approvalGrants.map((grant) => [grant.approvalId, grant]),
  );

  return toolCalls.map((call) => {
    const result = resultsByCallId.get(call.id);
    const request = requestsByCallId.get(call.id);
    if (request && !result) return actionFromApprovalRequest(call, request);
    if (!result) {
      return {
        toolCallId: call.id,
        provider: call.provider,
        action: call.toolName,
        state: "approval_required",
        governingLayer: "action",
        reason: "This action is waiting for an authoritative runtime decision.",
        outcome: "pending",
      };
    }

    const errorCode = toolResultErrorCode(result.output);
    if (result.policyDecision === "blocked" || errorCode === "tool_policy_blocked") {
      return {
        toolCallId: call.id,
        provider: call.provider,
        action: call.toolName,
        state: "blocked",
        governingLayer: "organization",
        reason: "Blocked by organization policy.",
        outcome: "not_run",
      };
    }
    if (errorCode === "tool_approval_unattended_denied") {
      return {
        toolCallId: call.id,
        provider: call.provider,
        action: call.toolName,
        state: "skipped",
        governingLayer: "session",
        reason: "Skipped by unattended policy because this write requires approval.",
        outcome: "not_run",
      };
    }
    if (
      result.policyDecision === "denied" ||
      errorCode === "tool_approval_denied"
    ) {
      const approvedRequest = result.approvalId
        ? requestsById.get(result.approvalId)
        : request;
      return {
        toolCallId: call.id,
        provider: call.provider,
        action: call.toolName,
        state: "denied",
        governingLayer: "action",
        reason: "Permission for this action was denied.",
        outcome: "not_run",
        ...(approvedRequest
          ? { approval: exactCallScope(call, approvedRequest) }
          : {}),
      };
    }
    if (result.policyDecision === "approved_by_user") {
      const grant = result.approvalId
        ? grantsById.get(result.approvalId)
        : undefined;
      const approvedRequest = result.approvalId
        ? requestsById.get(result.approvalId)
        : request;
      return {
        toolCallId: call.id,
        provider: call.provider,
        action: call.toolName,
        state: "approved",
        governingLayer: grant?.scope === "skill_tool" ? "agent_skill" : "action",
        reason:
          grant?.scope === "skill_tool"
            ? "Allowed by an active Skill-scoped approval."
            : "Approved for this exact action.",
        outcome: result.isError ? "failed" : "succeeded",
        approval: approvalScope(call, approvedRequest, grant, result.approvalId),
      };
    }
    if (result.policyDecision === "would_block") {
      return {
        toolCallId: call.id,
        provider: call.provider,
        action: call.toolName,
        state: "blocked",
        governingLayer: "organization",
        reason: "Legacy policy evidence indicates organization policy would block this action.",
        outcome: "not_run",
      };
    }
    if (
      result.policyDecision === "would_need_approval" ||
      result.policyDecision === "uncataloged_would_need_approval"
    ) {
      return {
        toolCallId: call.id,
        provider: call.provider,
        action: call.toolName,
        state: "approval_required",
        governingLayer: "action",
        reason: "Legacy policy evidence indicates this action requires approval.",
        outcome: "pending",
      };
    }
    return {
      toolCallId: call.id,
      provider: call.provider,
      action: call.toolName,
      state: "allowed",
      governingLayer: "organization",
      reason: "Allowed by organization policy.",
      outcome: result.isError ? "failed" : "succeeded",
    };
  });
}

function actionFromApprovalRequest(
  call: PersistedToolCall,
  request: PublicToolApprovalRequest,
): GuardrailActionReceipt {
  if (request.status === "approved") {
    return {
      toolCallId: call.id,
      provider: call.provider,
      action: call.toolName,
      state: "approved",
      governingLayer: "action",
      reason: "Approved for this exact action; execution is queued.",
      outcome: "pending",
      approval: exactCallScope(call, request),
    };
  }
  if (request.status === "denied" || request.status === "expired") {
    return {
      toolCallId: call.id,
      provider: call.provider,
      action: call.toolName,
      state: "denied",
      governingLayer: "action",
      reason:
        request.status === "expired"
          ? "The approval request expired before a decision was made."
          : "Permission for this action was denied.",
      outcome: "not_run",
      approval: exactCallScope(call, request),
    };
  }
  return {
    toolCallId: call.id,
    provider: call.provider,
    action: call.toolName,
    state: "approval_required",
    governingLayer: "action",
    reason: "Approval is required before this action can run.",
    outcome: "pending",
    approval: exactCallScope(call, request),
  };
}

function approvalScope(
  call: PersistedToolCall,
  request: PublicToolApprovalRequest | undefined,
  grant: ToolApprovalGrant | undefined,
  approvalId: string | undefined,
): GuardrailApprovalScope {
  if (grant?.scope === "skill_tool") {
    return {
      kind: "skill_tool",
      provider: grant.identity?.provider ?? call.provider,
      action: grant.identity?.nativeToolName ?? call.toolName,
      resourceScope: "tool_authority",
      resourceLabel: "All resources permitted by this tool for the active Skill",
      ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      ...(approvalId ? { approvalId } : {}),
    };
  }
  if (request) return exactCallScope(call, request);
  return {
    kind: "exact_call",
    provider: call.provider,
    action: call.toolName,
    resourceScope: "exact_request",
    resourceLabel: "Only this exact request",
    ...(approvalId ? { approvalId } : {}),
  };
}

function exactCallScope(
  call: PersistedToolCall,
  request: PublicToolApprovalRequest,
): GuardrailApprovalScope {
  return {
    kind: "exact_call",
    provider: request.provider ?? call.provider,
    action: request.nativeToolName ?? call.toolName,
    resourceScope: "exact_request",
    resourceLabel: "Only this exact request",
    expiresAt: request.expiresAt,
    approvalId: request.id,
  };
}

function parseProviderReceipt(value: unknown): GuardrailProviderReceipt[] {
  if (!isRecord(value)) return [];
  if (
    typeof value.provider !== "string" ||
    !isProviderState(value.state) ||
    (value.governingLayer !== "connection" &&
      value.governingLayer !== "organization") ||
    typeof value.reason !== "string" ||
    typeof value.mounted !== "boolean" ||
    (value.remediation !== undefined && !isRemediation(value.remediation))
  ) {
    return [];
  }
  return [
    {
      provider: value.provider,
      state: value.state,
      governingLayer: value.governingLayer,
      reason: value.reason,
      mounted: value.mounted,
      ...(value.remediation ? { remediation: value.remediation } : {}),
    },
  ];
}

function parseActionReceipt(value: unknown): GuardrailActionReceipt[] {
  if (!isRecord(value)) return [];
  if (
    typeof value.toolCallId !== "string" ||
    (value.provider !== null && typeof value.provider !== "string") ||
    typeof value.action !== "string" ||
    !isActionState(value.state) ||
    !isGoverningLayer(value.governingLayer) ||
    typeof value.reason !== "string" ||
    !isActionOutcome(value.outcome)
  ) {
    return [];
  }
  const approval = parseApprovalScope(value.approval);
  if (value.approval !== undefined && !approval) return [];
  return [
    {
      toolCallId: value.toolCallId,
      provider: value.provider,
      action: value.action,
      state: value.state,
      governingLayer: value.governingLayer,
      reason: value.reason,
      outcome: value.outcome,
      ...(approval ? { approval } : {}),
    },
  ];
}

function parseApprovalScope(value: unknown): GuardrailApprovalScope | null {
  if (!isRecord(value)) return null;
  if (
    (value.kind !== "exact_call" && value.kind !== "skill_tool") ||
    (value.provider !== null && typeof value.provider !== "string") ||
    typeof value.action !== "string" ||
    (value.resourceScope !== "exact_request" &&
      value.resourceScope !== "tool_authority") ||
    typeof value.resourceLabel !== "string" ||
    (value.expiresAt !== undefined &&
      (typeof value.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(value.expiresAt)))) ||
    (value.approvalId !== undefined && typeof value.approvalId !== "string")
  ) {
    return null;
  }
  return {
    kind: value.kind,
    provider: value.provider,
    action: value.action,
    resourceScope: value.resourceScope,
    resourceLabel: value.resourceLabel,
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
    ...(value.approvalId ? { approvalId: value.approvalId } : {}),
  };
}

function parseGuardrailBudgetReceipt(value: unknown): GuardrailBudgetReceipt | null {
  if (!isRecord(value)) return null;
  if (
    !isGoverningLayer(value.governingLayer) ||
    !isRecord(value.limits) ||
    !isRecord(value.consumed) ||
    typeof value.partial !== "boolean" ||
    (value.reached !== undefined && !isBudgetDimension(value.reached))
  ) {
    return null;
  }
  const limits = parseBudgetValues(value.limits);
  const consumed = parseBudgetValues(value.consumed);
  if (!limits || !consumed) return null;
  return {
    governingLayer: value.governingLayer,
    limits,
    consumed,
    ...(value.reached ? { reached: value.reached } : {}),
    partial: value.partial,
  };
}

function parseBudgetValues(
  value: Record<string, unknown>,
): GuardrailBudgetReceipt["limits"] | null {
  const keys = ["tokens", "usd", "wallClockMs", "toolIterations"] as const;
  const parsed: GuardrailBudgetReceipt["limits"] = {};
  for (const key of keys) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
      return null;
    }
    parsed[key] = candidate;
  }
  return parsed;
}

function toolResultErrorCode(output: unknown): string | null {
  if (isRecord(output) && typeof output.error === "string") return output.error;
  if (typeof output !== "string") return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    return isRecord(parsed) && typeof parsed.error === "string"
      ? parsed.error
      : null;
  } catch {
    return null;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAutonomyPresetName(value: unknown): value is AutonomyPresetName {
  return value === "interactive" || value === "unattended" || value === "restricted";
}

function isProviderState(value: unknown): value is GuardrailProviderState {
  return (
    value === "ready" ||
    value === "not_connected" ||
    value === "attestation_required" ||
    value === "reconnect_required" ||
    value === "execution_unavailable"
  );
}

function isActionState(value: unknown): value is GuardrailActionState {
  return (
    value === "allowed" ||
    value === "approval_required" ||
    value === "approved" ||
    value === "denied" ||
    value === "blocked" ||
    value === "skipped"
  );
}

function isGoverningLayer(value: unknown): value is GuardrailGoverningLayer {
  return (
    value === "organization" ||
    value === "agent_skill" ||
    value === "session" ||
    value === "action" ||
    value === "connection"
  );
}

function isActionOutcome(
  value: unknown,
): value is GuardrailActionReceipt["outcome"] {
  return (
    value === "pending" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "not_run"
  );
}

function isRemediation(
  value: unknown,
): value is NonNullable<GuardrailProviderReceipt["remediation"]> {
  return (
    value === "connect" ||
    value === "attest" ||
    value === "reconnect" ||
    value === "contact_admin"
  );
}

function isBudgetDimension(
  value: unknown,
): value is NonNullable<GuardrailBudgetReceipt["reached"]> {
  return (
    value === "tokens" ||
    value === "usd" ||
    value === "wall_clock" ||
    value === "tool_iterations"
  );
}
