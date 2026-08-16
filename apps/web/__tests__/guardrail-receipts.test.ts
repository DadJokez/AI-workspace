import type { ToolApprovalGrant } from "@ai-workspace/agent";
import { describe, expect, it } from "vitest";

import type { ChatContextReceipt } from "@/lib/chat-context-pack";
import {
  buildGuardrailReceipt,
  parseGuardrailReceipt,
} from "@/lib/guardrail-receipts";
import type { PersistedToolCall, PersistedToolResult } from "@/lib/tool-events";
import type { PublicToolApprovalRequest } from "@/lib/tool-approvals";

const generatedAt = new Date("2026-08-16T12:00:00.000Z");

function call(
  id: string,
  toolName: string,
  provider = "google",
): PersistedToolCall {
  return {
    id,
    name: `mcp__${provider}__${toolName}`,
    provider,
    toolName,
    input: { private: "must-not-leak", resourceId: "secret-resource" },
    startedAt: "2026-08-16T11:59:58.000Z",
  };
}

function result(
  toolCallId: string,
  overrides: Partial<PersistedToolResult> = {},
): PersistedToolResult {
  return {
    toolCallId,
    output: { ok: true },
    isError: false,
    policyDecision: "auto_allowed",
    completedAt: "2026-08-16T11:59:59.000Z",
    ...overrides,
  };
}

function approval(
  overrides: Partial<PublicToolApprovalRequest> = {},
): PublicToolApprovalRequest {
  return {
    id: "approval-1",
    batchId: "batch-1",
    toolCallId: "write-1",
    toolName: "mcp__google__draft_email",
    provider: "google",
    nativeToolName: "draft_email",
    redactedInput: { to: ["redacted@example.com"] },
    status: "pending",
    requestedAt: "2026-08-16T11:59:59.000Z",
    expiresAt: "2026-08-17T11:59:59.000Z",
    ...overrides,
  };
}

function contextReceipt(
  providers: ChatContextReceipt["tools"]["providers"],
): ChatContextReceipt {
  return {
    version: 1,
    schema: "context-pack.v2",
    generatedAt: generatedAt.toISOString(),
    autonomy: { preset: "interactive" },
    vault: {
      checked: false,
      injected: false,
      approvedMemoryChars: 0,
      approvedMemoryItems: 0,
    },
    tools: {
      connected: providers.filter((item) => item.connected).map((item) => item.provider),
      approved: providers.filter((item) => item.approved).map((item) => item.provider),
      mounted: providers.filter((item) => item.mounted).map((item) => item.provider),
      discoverable: [],
      builtinMounted: [],
      webAccess: {
        state: "not_granted",
        source: "not_declared",
        policy: "admin_domain_denylist",
        deniedDomainCount: 0,
      },
      pendingApproval: [],
      executionUnavailable: [],
      reconnectRequired: [],
      providers,
    },
    work: {
      recentMessages: 0,
      artifactContextInjected: false,
      artifactContextChars: 0,
      uploadedFilesInjected: false,
      uploadedFiles: [],
      resources: null,
    },
    capabilities: {
      providers: 0,
      skills: 0,
      apps: 0,
      schedules: 0,
      runnableNow: 0,
      needsApproval: 0,
      connectedNotMountedProviders: [],
    },
    contextItems: [],
    recommendations: {
      tool: 0,
      save_as_skill: 0,
      run_existing_skill: 0,
      open_existing_app: 0,
      deploy_artifact_as_app: 0,
      schedule_skill: 0,
    },
  };
}

function provider(
  name: string,
  overrides: Partial<ChatContextReceipt["tools"]["providers"][number]> = {},
): ChatContextReceipt["tools"]["providers"][number] {
  return {
    provider: name,
    source: "oauth_tokens",
    owner: "user",
    freshness: "live_account",
    visibility: "receipt_only",
    connected: true,
    approved: true,
    mounted: true,
    pendingApproval: false,
    injected: false,
    ...overrides,
  };
}

describe("authoritative guardrail receipts", () => {
  it("distinguishes ready, missing, unattested, reconnect, and execution states", () => {
    const receipt = buildGuardrailReceipt({
      runId: "run-1",
      autonomyPreset: "interactive",
      contextReceipt: contextReceipt([
        provider("github"),
        provider("google", { approved: false, mounted: false, pendingApproval: true }),
        provider("notion", { mounted: false, reconnectRequired: true }),
        provider("salesforce", { mounted: false, executionUnavailable: true }),
      ]),
      requestedProviders: ["github", "google", "notion", "salesforce", "slack"],
      generatedAt,
    });

    expect(receipt.providers.map(({ provider: name, state }) => [name, state])).toEqual([
      ["github", "ready"],
      ["google", "attestation_required"],
      ["notion", "reconnect_required"],
      ["salesforce", "execution_unavailable"],
      ["slack", "not_connected"],
    ]);
    expect(receipt.providers.find((item) => item.provider === "salesforce")).toMatchObject({
      governingLayer: "organization",
      remediation: "contact_admin",
    });
  });

  it("projects each enforced action state without copying tool input", () => {
    const calls = [
      call("read-1", "search_mail"),
      call("blocked-1", "delete_account"),
      call("skipped-1", "draft_email"),
      call("denied-1", "create_event"),
      call("approved-1", "draft_email"),
    ];
    const receipt = buildGuardrailReceipt({
      runId: "run-2",
      autonomyPreset: "unattended",
      toolCalls: calls,
      toolResults: [
        result("read-1"),
        result("blocked-1", {
          output: { error: "tool_policy_blocked" },
          isError: true,
          policyDecision: "blocked",
        }),
        result("skipped-1", {
          output: { error: "tool_approval_unattended_denied" },
          isError: true,
          policyDecision: "denied",
        }),
        result("denied-1", {
          output: { error: "tool_approval_denied" },
          isError: true,
          policyDecision: "denied",
          approvalId: "approval-denied",
        }),
        result("approved-1", {
          policyDecision: "approved_by_user",
          approvalId: "approval-standing",
        }),
      ],
      approvalRequests: [
        approval({
          id: "approval-denied",
          toolCallId: "denied-1",
          nativeToolName: "create_event",
          status: "denied",
        }),
      ],
      approvalGrants: [
        {
          schema: "comparative.tool-approval-grant.v1",
          approvalId: "approval-standing",
          identity: {
            kind: "mcp",
            provider: "google",
            endpoint: "https://example.invalid/mcp",
            nativeToolName: "draft_email",
          },
          scope: "skill_tool",
          expiresAt: "2026-09-15T12:00:00.000Z",
          decision: "approved",
        } satisfies ToolApprovalGrant,
      ],
      generatedAt,
    });

    expect(receipt.actions.map(({ state }) => state)).toEqual([
      "allowed",
      "blocked",
      "skipped",
      "denied",
      "approved",
    ]);
    expect(receipt.actions[1]).toMatchObject({
      governingLayer: "organization",
      reason: "Blocked by organization policy.",
      outcome: "not_run",
    });
    expect(receipt.actions[2]).toMatchObject({
      governingLayer: "session",
      reason: expect.stringContaining("unattended policy"),
    });
    expect(receipt.actions[4]?.approval).toEqual({
      kind: "skill_tool",
      provider: "google",
      action: "draft_email",
      resourceScope: "tool_authority",
      resourceLabel: "All resources permitted by this tool for the active Skill",
      expiresAt: "2026-09-15T12:00:00.000Z",
      approvalId: "approval-standing",
    });
    expect(JSON.stringify(receipt)).not.toContain("must-not-leak");
    expect(JSON.stringify(receipt)).not.toContain("secret-resource");
  });

  it("shows a durable exact-call approval wait with scope and expiry", () => {
    const request = approval();
    const receipt = buildGuardrailReceipt({
      runId: "run-3",
      autonomyPreset: "interactive",
      toolCalls: [call("write-1", "draft_email")],
      approvalRequests: [request],
      generatedAt,
    });

    expect(receipt.actions).toEqual([
      expect.objectContaining({
        state: "approval_required",
        governingLayer: "action",
        outcome: "pending",
        approval: {
          kind: "exact_call",
          provider: "google",
          action: "draft_email",
          resourceScope: "exact_request",
          resourceLabel: "Only this exact request",
          expiresAt: request.expiresAt,
          approvalId: request.id,
        },
      }),
    ]);
  });

  it("round-trips valid receipts and rejects unknown or malformed versions", () => {
    const receipt = buildGuardrailReceipt({
      runId: "run-4",
      autonomyPreset: "restricted",
      generatedAt,
    });
    expect(parseGuardrailReceipt(receipt)).toEqual(receipt);
    expect(parseGuardrailReceipt({ ...receipt, version: 2 })).toBeNull();
    expect(
      parseGuardrailReceipt({
        ...receipt,
        actions: [{ state: "allowed", rawInput: "secret" }],
      }),
    ).toBeNull();
  });

  it("passes through only a measured, schema-valid budget receipt", () => {
    const receipt = buildGuardrailReceipt({
      runId: "run-5",
      autonomyPreset: "interactive",
      budget: {
        governingLayer: "session",
        limits: { tokens: 10_000, usd: 1, wallClockMs: 60_000 },
        consumed: { tokens: 9_000, usd: 0.42, wallClockMs: 12_000 },
        reached: "tokens",
        partial: true,
      },
      generatedAt,
    });
    expect(receipt.budget).toMatchObject({ reached: "tokens", partial: true });

    const invalid = buildGuardrailReceipt({
      runId: "run-6",
      autonomyPreset: "interactive",
      budget: {
        governingLayer: "session",
        limits: { usd: "model estimate" },
        consumed: {},
        partial: false,
      },
      generatedAt,
    });
    expect(invalid).not.toHaveProperty("budget");
  });
});
