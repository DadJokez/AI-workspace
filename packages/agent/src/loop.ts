import {
  type BedrockClient,
  type BedrockContentBlock,
  type BedrockMessage,
  getBedrockClient,
} from "./clients";
import { MODELS, type ModelId } from "./models";
import type { ToolRegistry } from "./registry";
import type { AgentEvent, AgentMessage, ToolContext } from "./types";

export interface RunAgentLoopParams {
  modelId: ModelId;
  systemPrompt?: string;
  messages: AgentMessage[];
  /** Tool registry to resolve calls against. Empty registry = no tools. */
  registry: ToolRegistry;
  /** Whitelist of tool names this run is allowed to use. Undefined = all registered tools. */
  allowedTools?: readonly string[];
  /**
   * Tool the first model step must request. The loop fails closed when the
   * tool is not registered, then returns to automatic selection after the
   * required tool result is available.
   */
  requiredToolName?: string;
  /** Hard cap on tool-use round trips per turn. Defaults to 8. */
  maxToolIterations?: number;
  /** Per-output-message token cap. Defaults to the model's `defaultMaxTokens`. */
  maxTokens?: number;
  /** Optional sampling temperature. Omitted for normal product defaults. */
  temperature?: number;
  context: ToolContext;
  /** Aborts the loop. */
  signal?: AbortSignal;
  /** Override the resolved Bedrock client. Tests pass a fake here. */
  client?: BedrockClient;
}

export const DEFAULT_MAX_TOOL_ITERATIONS = 8;

/**
 * Appended to the assistant text when generation stops at the output-token
 * cap. Without it the turn "succeeds" with a mid-sentence artifact and the
 * chat looks stalled (feedback a1eff7e5 / issue #320) — the user must be told
 * the response was cut, and the note in history lets a follow-up "continue"
 * turn see where the cut happened.
 */
export const MAX_TOKENS_TRUNCATION_NOTICE =
  "\n\n---\n*I hit my output length limit mid-response, so the content above is incomplete. Say “continue” and I’ll pick up where I left off.*";

/**
 * True when `text` ends inside an unterminated ``` code fence (an odd number of
 * fence markers). #320 truncation cuts the model off mid-artifact, so the
 * assistant text ends with a dangling ```` ``` ````. Every fence-parsing
 * consumer (transcript render, artifact persistence) treats an unclosed fence
 * as running to end-of-string — which would swallow the truncation notice into
 * the collapsed artifact preview and the persisted `.html`, hiding it in the
 * exact case it targets. We close the fence before the notice so it lands as
 * its own visible markdown part and stays out of the saved artifact.
 */
export function hasUnclosedCodeFence(text: string): boolean {
  const markers = text.match(/```/g);
  return markers !== null && markers.length % 2 === 1;
}

/**
 * Runs a single chat turn end-to-end: text generation plus optional tool-use
 * round-trips. Yields `AgentEvent`s as they happen so the web layer can relay
 * them as SSE.
 *
 * Tool use is plumbed but disabled until the first real tool registers
 * (no-op when `allowedTools` is empty or unset on an empty registry).
 */
export async function* runAgentLoop(
  params: RunAgentLoopParams,
): AsyncGenerator<AgentEvent, void, void> {
  const model = MODELS[params.modelId];
  const client = params.client ?? getBedrockClient();
  // The stable prompt must stay byte-identical across turns — it sits inside
  // the Bedrock prompt-cache prefix (see ConverseStreamParams.systemPrompt).
  const systemPrompt = [
    `You are Claude ${model.displayName}, made by Anthropic. If asked which model or version you are, answer "Claude ${model.displayName}" — never claim to be an older model such as "Claude 3.5".`,
    params.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  // Ground every turn in the real clock. Models have no reliable sense of
  // "now" — without this, date questions get confident hallucinations
  // (observed: "31 days until Christmas 2024", mid-June 2026). Rendered after
  // the cache checkpoint so the per-turn timestamp can't defeat caching.
  const volatileSystemSuffix = `Current date and time (UTC): ${new Date().toISOString()}. Treat this as ground truth for any date or time reasoning; the user's local timezone may differ.`;
  const maxIter = params.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const tools = params.registry.list(params.allowedTools);
  const baseToolConfig =
    tools.length > 0
      ? params.registry.toBedrockToolConfig(params.allowedTools)
      : undefined;
  const requiredToolName = params.requiredToolName?.trim();
  if (
    requiredToolName &&
    !tools.some((tool) => tool.name === requiredToolName)
  ) {
    yield {
      type: "error",
      message: `Required tool is unavailable: ${requiredToolName}`,
    };
    return;
  }

  const bedrockMessages: BedrockMessage[] = params.messages.map(
    agentMessageToBedrock,
  );

  let totalTokensIn = 0;
  let totalTokensOut = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    if (params.signal?.aborted) {
      yield { type: "error", message: "aborted" };
      return;
    }

    const toolConfig =
      baseToolConfig && iter === 0 && requiredToolName
        ? {
            ...baseToolConfig,
            toolChoice: { tool: { name: requiredToolName } },
          }
        : baseToolConfig;
    const stream = client.converseStream({
      bedrockModelId: model.bedrockModelId,
      systemPrompt,
      volatileSystemSuffix,
      messages: bedrockMessages,
      toolConfig,
      maxTokens: params.maxTokens ?? model.defaultMaxTokens,
      temperature: params.temperature,
      signal: params.signal,
    });

    const assistantBlocks: BedrockContentBlock[] = [];
    let pendingText = "";
    const pendingToolCalls: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" =
      "end_turn";

    for await (const ev of stream) {
      if (params.signal?.aborted) {
        yield { type: "error", message: "aborted" };
        return;
      }
      if (ev.type === "text-delta") {
        pendingText += ev.text;
        yield { type: "text-delta", delta: ev.text };
      } else if (ev.type === "tool-use") {
        pendingToolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
        yield {
          type: "tool-call",
          call: { id: ev.id, name: ev.name, input: ev.input },
        };
      } else if (ev.type === "usage") {
        totalTokensIn += ev.tokensIn;
        totalTokensOut += ev.tokensOut;
      } else if (ev.type === "stop") {
        stopReason = ev.reason;
      }
    }

    if (pendingText) {
      assistantBlocks.push({ kind: "text", text: pendingText });
    }
    for (const t of pendingToolCalls) {
      assistantBlocks.push({
        kind: "tool-use",
        id: t.id,
        name: t.name,
        input: t.input,
      });
    }
    bedrockMessages.push({ role: "assistant", content: assistantBlocks });

    if (stopReason !== "tool_use" || pendingToolCalls.length === 0) {
      if (stopReason === "max_tokens") {
        const fenceClose = hasUnclosedCodeFence(pendingText) ? "\n```" : "";
        yield {
          type: "text-delta",
          delta: fenceClose + MAX_TOKENS_TRUNCATION_NOTICE,
        };
      }
      break;
    }

    // Execute tool calls and feed the results back as a user-role message.
    const resultBlocks: BedrockContentBlock[] = [];
    for (const call of pendingToolCalls) {
      const tool = params.registry.get(call.name);
      if (!tool) {
        const errMsg = `Tool not registered: ${call.name}`;
        yield {
          type: "tool-result",
          result: { toolCallId: call.id, output: errMsg, isError: true },
        };
        resultBlocks.push({
          kind: "tool-result",
          toolUseId: call.id,
          content: errMsg,
          isError: true,
        });
        continue;
      }
      try {
        const output = await tool.handler(call.input, params.context);
        const text = typeof output === "string" ? output : JSON.stringify(output);
        yield {
          type: "tool-result",
          result: { toolCallId: call.id, output },
        };
        resultBlocks.push({
          kind: "tool-result",
          toolUseId: call.id,
          content: text,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield {
          type: "tool-result",
          result: { toolCallId: call.id, output: msg, isError: true },
        };
        resultBlocks.push({
          kind: "tool-result",
          toolUseId: call.id,
          content: msg,
          isError: true,
        });
      }
    }
    bedrockMessages.push({ role: "user", content: resultBlocks });
  }

  yield { type: "usage", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
  yield { type: "done" };
}

function agentMessageToBedrock(m: AgentMessage): BedrockMessage {
  if (m.role === "tool") {
    // Tool messages from history map to user-role tool-result blocks.
    const blocks: BedrockContentBlock[] =
      m.toolResults?.map((r) => ({
        kind: "tool-result",
        toolUseId: r.toolCallId,
        content:
          typeof r.output === "string" ? r.output : JSON.stringify(r.output),
        isError: r.isError,
      })) ?? [];
    return { role: "user", content: blocks };
  }
  if (m.role === "assistant") {
    const blocks: BedrockContentBlock[] = [];
    if (m.content) blocks.push({ kind: "text", text: m.content });
    for (const c of m.toolCalls ?? []) {
      blocks.push({
        kind: "tool-use",
        id: c.id,
        name: c.name,
        input: c.input,
      });
    }
    return { role: "assistant", content: blocks };
  }
  const blocks: BedrockContentBlock[] = [{ kind: "text", text: m.content }];
  for (const attachment of m.attachments ?? []) {
    if (attachment.type !== "image") continue;
    const format = imageFormatFromMimeType(attachment.mimeType);
    if (!format) continue;
    blocks.push({
      kind: "image",
      format,
      dataBase64: attachment.dataBase64,
    });
  }
  return { role: "user", content: blocks };
}

function imageFormatFromMimeType(
  mimeType: string,
): "png" | "jpeg" | "webp" | null {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpeg";
  if (mimeType === "image/webp") return "webp";
  return null;
}
