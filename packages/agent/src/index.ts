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
} from "./types";

export {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  MODELS,
  estimateCostUsd,
  getModel,
  isValidModelId,
} from "./models";
export type { ModelId, ModelMetadata } from "./models";

export { ToolRegistry } from "./registry";
export type { BedrockToolConfig } from "./registry";

export {
  FakeBedrockClient,
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

export { DEFAULT_MAX_TOOL_ITERATIONS, runAgentLoop } from "./loop";
export type { RunAgentLoopParams } from "./loop";

export { connectMcpTools, mcpToolName } from "./mcp";
export type { McpHttpServerSpec, McpToolConnection } from "./mcp";
