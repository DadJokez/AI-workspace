import type { JSONSchema7 } from "json-schema";
import type { RunBudgetReceipt } from "./run-budget";

/**
 * Per-request context passed to every tool handler.
 * Add fields here as new cross-cutting needs emerge (request id, abort signal, telemetry, etc.).
 */
export interface ToolContext {
  userId: string;
}

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  ctx: ToolContext,
) => Promise<TOutput>;

export type ToolRuntimePolicy =
  | "always_allow"
  | "needs_approval"
  | "blocked";

export type ToolPolicyAuditDecision =
  | "auto_allowed"
  | "approved_by_user"
  | "denied"
  | "blocked"
  | "would_need_approval"
  | "would_block"
  | "uncataloged_would_need_approval";

/** Endpoint-bound identity for a tool mounted from a trusted MCP server. */
export interface McpToolExecutionIdentity {
  kind: "mcp";
  provider: string;
  endpoint: string;
  nativeToolName: string;
}

/** Serializable pause payload used by both runtime lanes in the approval slice. */
export interface ToolApprovalRequest {
  schema: "comparative.tool-approval-request.v1";
  toolCallId: string;
  toolName: string;
  identity?: McpToolExecutionIdentity;
  /** Canonical SHA-256 identity + argument fingerprint for exact-call grants. */
  fingerprint: string;
}

export interface ToolApprovalGrant {
  schema: "comparative.tool-approval-grant.v1";
  approvalId: string;
  /** Durable identity + canonical arguments; provider tool-call ids regenerate. */
  fingerprint?: string;
  /** Skill-scoped grants match only this trusted endpoint/tool identity. */
  identity?: McpToolExecutionIdentity;
  scope?: "exact_call" | "skill_tool";
  /** ISO timestamp; runtimes reject an expired standing grant fail-closed. */
  expiresAt?: string;
  decision: "approved" | "denied";
  /** Once consumed, the receipt may replay its result but never execute again. */
  consumed?: boolean;
  /** Redacted persisted output used to resume a multi-approval turn safely. */
  replayOutput?: unknown;
}

/** What the runtime does when a write lacks an applicable approval grant. */
export type ToolApprovalMode = "request" | "deny_unattended";

/**
 * Standard tool shape. Same interface whether the handler hits Microsoft Graph,
 * an internal API, a future MCP server, or pure compute. Bedrock's converse API
 * doesn't care about the source — neither does the rest of the system.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  handler: ToolHandler<TInput, TOutput>;
  /** Deterministic runtime policy resolved before the tool reaches the loop. */
  policy?: ToolRuntimePolicy;
  /** Exact trusted endpoint/tool identity used to resolve MCP policy. */
  executionIdentity?: McpToolExecutionIdentity;
  /**
   * Trusted application guidance delivered with this tool's first completed
   * result in an agent turn. It is intentionally omitted from the mounted
   * tool schema and raw `tool-result` event so unused guidance costs no prompt
   * tokens and persistence keeps the provider's output unchanged.
   */
  usageNotes?: string;
  /**
   * #497: marks output a third party can influence. `connectMcpTools` sets
   * this on every wrapped MCP tool; the agent loop then nonce-frames the
   * serialized output as DATA at the model-visible boundary
   * (`frameUntrustedToolResult`). Emitted `tool-result` events keep the raw
   * output for persistence and structured consumers. First-party tools that
   * already frame their own content (web fetch/search) leave this unset —
   * double-framing is noise.
   */
  untrustedOutput?: boolean;
}

export type Role = "user" | "assistant" | "tool";

export interface AgentMessage {
  role: Role;
  content: string;
  attachments?: AgentMessageAttachment[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export type AgentMessageAttachment = {
  type: "image";
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
};

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  output: unknown;
  isError?: boolean;
  /** Actual runtime decision when enforcement metadata reached the executor. */
  policyDecision?: ToolPolicyAuditDecision;
  /** Durable approval receipt consumed by this exact tool call. */
  approvalId?: string;
  /** True only when this result carried the tool's JIT usage guidance. */
  usageNotesDelivered?: boolean;
}

export interface TokenUsage {
  /** Total input footprint: uncached input + cache reads + cache writes. */
  tokensIn: number;
  tokensOut: number;
  /** Input tokens billed at the normal input rate. */
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
}

export interface ProviderResponseMetadata {
  iteration: number;
  stopReason?: string;
  latencyMs?: number;
  performanceLatency?: string;
  serviceTier?: string;
  additionalModelResponseFields?: unknown;
}

export type ProviderRequestContentBlock =
  | { kind: "text"; text: string }
  | {
      kind: "image";
      format: "png" | "jpeg" | "webp";
      sizeBytes: number;
    }
  | {
      kind: "tool-use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "tool-result";
      toolUseId: string;
      content: string;
      isError?: boolean;
    }
  | {
      kind: "reasoning";
      text: string;
      signaturePresent: boolean;
    }
  | { kind: "reasoning-redacted"; sizeBytes: number };

export interface ProviderRequestSnapshot {
  providerModelId: string;
  systemPrompt?: string;
  volatileSystemSuffix?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: ProviderRequestContentBlock[];
  }>;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: JSONSchema7;
  }>;
}

/**
 * Streaming events emitted by `runAgentLoop`. The web layer relays these as SSE.
 * Concrete implementation lands in a follow-up PR; types are locked here so consumers compile.
 */
export type AgentEvent =
  | { type: "text-delta"; delta: string }
  | {
      type: "provider-request";
      iteration: number;
      request: ProviderRequestSnapshot;
    }
  | {
      type: "provider-reasoning-delta";
      iteration: number;
      blockIndex: number;
      delta: string;
    }
  | {
      type: "provider-reasoning-redacted";
      iteration: number;
      blockIndex: number;
    }
  | ({ type: "provider-response-metadata" } & ProviderResponseMetadata)
  | { type: "tool-call"; call: ToolCall }
  | { type: "tool-approval-required"; requests: ToolApprovalRequest[] }
  | { type: "tool-result"; result: ToolResult }
  | ({ type: "usage" } & TokenUsage)
  | { type: "budget"; receipt: RunBudgetReceipt }
  | {
      type: "error";
      message: string;
      /**
       * #713: set when this error is a per-provider MCP mount failure the
       * turn recovered from (healthy providers still mounted, the model was
       * told honestly). Consumers record it in logs/receipts but must not
       * fail the run or trigger model failover over it.
       */
      degradedProvider?: string;
    }
  | { type: "done" };
