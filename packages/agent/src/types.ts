import type { JSONSchema7 } from "json-schema";

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
}

/**
 * Streaming events emitted by `runAgentLoop`. The web layer relays these as SSE.
 * Concrete implementation lands in a follow-up PR; types are locked here so consumers compile.
 */
export type AgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "tool-result"; result: ToolResult }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "error"; message: string }
  | { type: "done" };
