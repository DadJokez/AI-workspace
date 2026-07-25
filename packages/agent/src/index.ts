export type {
  AgentEvent,
  AgentMessage,
  AgentMessageAttachment,
  ProviderRequestContentBlock,
  ProviderRequestSnapshot,
  ProviderResponseMetadata,
  Role,
  Tool,
  ToolCall,
  ToolContext,
  ToolHandler,
  ToolResult,
  TokenUsage,
} from "./types";

export {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODEL_PURPOSES,
  MODELS,
  PLATFORM_MODEL_OVERRIDE_ID,
  estimateCostUsd,
  getModel,
  isValidModelId,
  isValidModelPurpose,
} from "./models";
export type { ModelId, ModelMetadata, ModelPurpose } from "./models";

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
  runAgentLoop,
} from "./loop";
export type { RunAgentLoopParams } from "./loop";

export { connectMcpTools, mcpToolName } from "./mcp";
export type { McpHttpServerSpec, McpToolConnection } from "./mcp";

export { normalizeUserTimeZone, renderClockStatement } from "./timezone";

export {
  renderResolvedDateReferences,
  resolveRelativeDateReferences,
} from "./temporal";
export type { ResolvedDateReference } from "./temporal";

export {
  buildExactOutputContract,
  EXACT_OUTPUT_CONTRACT,
} from "./exact-output";

export { extractAssistantSources, parseAssistantSources } from "./sources";
export type { AssistantSource, AssistantSourceKind } from "./sources";
