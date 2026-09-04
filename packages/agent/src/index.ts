export type {
  AgentEvent,
  AgentMessage,
  AgentMessageAttachment,
  McpToolExecutionIdentity,
  ProviderRequestContentBlock,
  ProviderRequestSnapshot,
  ProviderResponseMetadata,
  Role,
  Tool,
  ToolApprovalGrant,
  ToolApprovalMode,
  ToolApprovalRequest,
  ToolCall,
  ToolContext,
  ToolHandler,
  ToolPolicyAuditDecision,
  ToolResult,
  ToolRuntimePolicy,
  TokenUsage,
} from "./types";

export { UNDECLARED_TOOL_POLICY } from "./types";

export {
  buildToolApprovalRequest,
  isStandingToolApprovalGrant,
  matchingToolApprovalGrant,
  toolCallFingerprint,
} from "./tool-approval";

export {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODEL_INVOCATIONS,
  MODEL_PURPOSES,
  MODELS,
  PLATFORM_MODEL_OVERRIDE_ID,
  estimateCostUsd,
  estimateUsageCostUsd,
  getModel,
  isValidModelId,
  isValidModelPurpose,
} from "./models";
export type {
  ModelId,
  ModelInvocation,
  ModelMetadata,
  ModelPurpose,
} from "./models";

export { modelIdentityLine } from "./model-identity";

export {
  RUN_BUDGET_RECEIPT_SCHEMA,
  RUN_BUDGET_SCHEMA,
  RunBudgetTracker,
  parseRunBudgetReceipt,
  parseRunBudgetState,
} from "./run-budget";
export type {
  RunBudgetConsumption,
  RunBudgetDimension,
  RunBudgetEnvelope,
  RunBudgetGoverningLayer,
  RunBudgetLimits,
  RunBudgetReceipt,
  RunBudgetState,
} from "./run-budget";

export { normalizeToolInputSchema, ToolRegistry } from "./registry";
export type { BedrockToolConfig } from "./registry";

export {
  parseActivation,
  providerOfToolName,
  resolveMountedToolNames,
  serializeActivation,
} from "./tool-bundles";
export type { ToolDiscoveryState } from "./tool-bundles";

export {
  ACTIVATE_TOOLS_NAME,
  createDiscoveryTools,
  SEARCH_TOOLS_NAME,
} from "./discovery-tools";
export type {
  DiscoveryCatalogEntry,
  DiscoveryToolsOptions,
} from "./discovery-tools";

export {
  FakeBedrockClient,
  RealBedrockClient,
  getBedrockClient,
  toAwsToolConfiguration,
} from "./clients";
export type {
  BedrockClient,
  BedrockContentBlock,
  BedrockMessage,
  BedrockStreamEvent,
  ConverseStreamParams,
  FakeBedrockClientOptions,
} from "./clients";

export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  MAX_TOKENS_TRUNCATION_NOTICE,
  TOOL_POLICY_BLOCKED_CODE,
  runAgentLoop,
} from "./loop";
export type { RunAgentLoopParams } from "./loop";

export {
  connectMcpTools,
  mcpToolName,
  renderMcpMountFailureGuidance,
} from "./mcp";
export type {
  McpHttpServerSpec,
  McpProviderFailure,
  McpToolConnection,
} from "./mcp";

export { normalizeUserTimeZone, renderClockStatement } from "./timezone";

export {
  renderResolvedDateReferences,
  resolveRelativeDateReferences,
} from "./temporal";
export type { ResolvedDateReference } from "./temporal";

export {
  buildExactOutputContract,
  evaluateLiteralContract,
  extractPureEchoReply,
  EXACT_OUTPUT_CONTRACT,
  EXACT_OUTPUT_MEMORY_ACK,
} from "./exact-output";
export type {
  ExactOutputContract,
  ExactOutputSpec,
  LiteralContractOutcome,
} from "./exact-output";

export {
  CLEARED_TOOL_RESULT_MARKER,
  DEFAULT_KEEP_RECENT_TOOL_ROUNDS,
  DEFAULT_TOOL_RESULT_CLEAR_TRIGGER_CHARS,
  clearStaleToolResults,
} from "./context-lifecycle";
export type {
  ClearStaleToolResultsOptions,
  ClearStaleToolResultsOutcome,
  ClearedToolResult,
  ToolResultClearingReceipt,
} from "./context-lifecycle";

export {
  THREAD_SUMMARY_INSTRUCTION,
  THREAD_SUMMARY_MAX_ITEM_CHARS,
  THREAD_SUMMARY_MAX_ITEMS,
  THREAD_SUMMARY_SCHEMA,
  buildSummarizerInput,
  parseStoredThreadSummary,
  parseThreadSummaryOutput,
  renderThreadSummaryForPrompt,
  serializeThreadSummary,
} from "./thread-summary";
export type {
  SummarizableMessage,
  SummarizerInput,
  ThreadSummary,
  ThreadSummaryCarryOver,
  ThreadSummaryReference,
} from "./thread-summary";

export { extractAssistantSources, parseAssistantSources } from "./sources";
export type { AssistantSource, AssistantSourceKind } from "./sources";
