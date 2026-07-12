export type {
  AgentEvent,
  AgentMessage,
  AgentMessageAttachment,
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
  estimateCostUsd,
  getModel,
  isValidModelId,
  isValidModelPurpose,
} from "./models";
export type { ModelId, ModelMetadata, ModelPurpose } from "./models";

export { normalizeToolInputSchema, ToolRegistry } from "./registry";
export type { BedrockToolConfig } from "./registry";

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
