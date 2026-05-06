import type { AgentEvent, AgentMessage } from "@ai-workspace/agent";
import { Agent } from "@cursor/sdk";
import type {
  McpServerConfig,
  SDKAgent,
  SDKMessage,
} from "@cursor/sdk";

import type { AgentRuntime, TurnInput } from "./types";

/**
 * Cursor SDK-backed implementation of `AgentRuntime`.
 *
 * Differs from Bedrock in three ways:
 *
 *   1. Durable conversation state. The SDK owns it: we resolve an `SDKAgent`
 *      keyed on our `threadId` (creating one on first turn, resuming on
 *      subsequent turns) and only forward the newest user message.
 *   2. Tools via MCP, not in-process functions. Tool registration moves out
 *      of `ToolRegistry` and into `mcpServers` config on `Agent.create()`.
 *   3. Policy via `.cursor/hooks.json`. Pre/post-tool hooks intercept the
 *      run; the SDK respects the hook config without app-level plumbing.
 *
 * Step 3 of the spike: real `runTurn` implementation. The `threadId → agentId`
 * map is in-memory here; step 4 swaps in a DB-backed `ThreadAgentStore`.
 */
export interface CursorRuntimeOptions {
  /** Cursor API key. Falls back to `process.env.CURSOR_API_KEY` if omitted. */
  apiKey?: string;
  /**
   * Maps our logical thread id to a persisted Cursor `agentId`. Defaults to
   * an in-memory map; step 4 swaps in a `chat_threads.cursor_agent_id` store.
   */
  threadAgentStore?: ThreadAgentStore;
  /**
   * MCP server configs to pass to `Agent.create({ mcpServers })`. Wrapped in
   * a structural stub so the placeholder MCP packages don't need a real SDK
   * install.
   */
  mcpServers?: readonly McpServerConfigStub[];
}

export interface ThreadAgentRecord {
  agentId: string;
  /**
   * Stable identity of the MCP-server set the agent was created with.
   * Empty string = no MCP servers. NULL = legacy agent (predates the column).
   * The runtime force-recreates the agent when this differs from the
   * current turn's signature.
   */
  mcpSignature: string | null;
}

/** Read/write the persisted `threadId → cursor agentId` mapping. */
export interface ThreadAgentStore {
  get(threadId: string): Promise<ThreadAgentRecord | null>;
  set(threadId: string, record: ThreadAgentRecord): Promise<void>;
  /** Force a fresh agent on the next turn (used when MCP signature changes). */
  clear(threadId: string): Promise<void>;
}

/**
 * Mirror of `@cursor/sdk`'s `McpServerConfig` shape. Replace with the real
 * type import on promotion. Kept structural so the placeholder MCP packages
 * in `packages/mcp-servers/` can produce config objects without a real SDK
 * install.
 */
export interface McpServerConfigStub {
  name: string;
  command?: string;
  args?: readonly string[];
  url?: string;
  env?: Record<string, string>;
}

export class CursorRuntime implements AgentRuntime {
  readonly name = "cursor" as const;

  private readonly opts: CursorRuntimeOptions;
  private readonly store: ThreadAgentStore;

  constructor(opts: CursorRuntimeOptions = {}) {
    this.opts = opts;
    this.store = opts.threadAgentStore ?? new InMemoryThreadAgentStore();
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const lastUser = lastUserText(input.messages);
    if (!lastUser) {
      yield {
        type: "error",
        message:
          "CursorRuntime.runTurn: no user message in input.messages — Cursor agents are turn-based and need at least one user turn.",
      };
      return;
    }

    let agent: SDKAgent;
    let createdFresh: boolean;
    try {
      ({ agent, createdFresh } = await this.getOrCreateAgent(input));
    } catch (err) {
      logRuntimeError("getOrCreateAgent", input.threadId, err);
      yield { type: "error", message: `CursorRuntime: ${errorMessage(err)}` };
      return;
    }

    if (input.signal?.aborted) {
      yield { type: "done" };
      return;
    }

    // We create a fresh cloud agent every turn (resumed agents accumulate
    // MCP transport state and silently drop tool results on subsequent
    // tool calls). That means cloud-side conversation context is gone, so
    // we bundle prior history into the user message body and only send
    // the steering preamble on the very first turn of the thread.
    const isFirstThreadTurn = input.messages.length === 1;
    const priorBlock = buildPriorConversationBlock(input.messages);
    const parts: string[] = [];
    if (isFirstThreadTurn && input.firstTurnPreamble) {
      parts.push(input.firstTurnPreamble);
    }
    if (priorBlock) parts.push(priorBlock);
    parts.push(lastUser);
    const messageText = parts.join("\n\n");

    // Per-turn mcpServers override anything baked in at agent.create() time.
    // The TurnInput shape mirrors McpServerConfig structurally — see
    // packages/cursor-runtime/src/types.ts — so the cast is safe.
    const turnMcp = input.mcpServers as
      | Record<string, McpServerConfig>
      | undefined;
    let run;
    try {
      process.stderr.write(
        `[mcp-debug:agent.send] ${JSON.stringify({
          threadId: input.threadId,
          agentId: agent.agentId,
          createdFresh,
          mcpKeys: turnMcp ? Object.keys(turnMcp) : [],
        })}\n`,
      );
      run = await agent.send(messageText, {
        model: { id: toCursorModelId(input.modelId) },
        ...(turnMcp ? { mcpServers: turnMcp } : {}),
      });
    } catch (err) {
      logRuntimeError("send", input.threadId, err, {
        agentId: agent.agentId,
        mcpKeys: turnMcp ? Object.keys(turnMcp) : [],
      });
      yield {
        type: "error",
        message: `CursorRuntime.send: ${errorMessage(err)}`,
      };
      return;
    }

    const onAbort = () => {
      void run.cancel().catch(() => {});
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const m of run.stream()) {
        logSdkMessage(m, input.threadId, agent.agentId);
        yield* mapSdkMessage(m);
      }
    } catch (err) {
      logRuntimeError("stream", input.threadId, err, {
        agentId: agent.agentId,
      });
      yield { type: "error", message: `CursorRuntime.stream: ${errorMessage(err)}` };
      return;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }

    yield { type: "done" };
  }

  private async getOrCreateAgent(
    input: TurnInput,
  ): Promise<{ agent: SDKAgent; createdFresh: boolean }> {
    // Always create a fresh agent. Resumed cloud agents accumulate MCP
    // transport state across `agent.send` calls — the second tool call
    // hangs and the run finishes with no completion message, so the
    // model never sees a tool result. Conversation continuity is
    // preserved by bundling prior messages into the user message body
    // in `runTurn`. The `ThreadAgentStore` row is updated for visibility
    // but is no longer read.
    const turnMcp = input.mcpServers as
      | Record<string, McpServerConfig>
      | undefined;
    const baseMcp = toMcpRecord(this.opts.mcpServers);
    const mergedMcp = mergeMcp(baseMcp, turnMcp);
    process.stderr.write(
      `[mcp-debug:agent.create] ${JSON.stringify({
        threadId: input.threadId,
        modelId: toCursorModelId(input.modelId),
        mergedMcpDefined: !!mergedMcp,
        mergedMcpKeys: mergedMcp ? Object.keys(mergedMcp) : [],
        perKey: mergedMcp
          ? Object.fromEntries(
              Object.entries(mergedMcp).map(([k, v]) => [
                k,
                {
                  type: (v as { type?: string }).type,
                  hasUrl: !!(v as { url?: string }).url,
                  hasHeaders: !!(v as { headers?: unknown }).headers,
                  headerKeys: Object.keys(
                    ((v as { headers?: Record<string, string> }).headers ?? {}),
                  ),
                },
              ]),
            )
          : null,
      })}\n`,
    );
    const agent = await Agent.create({
      apiKey: this.opts.apiKey,
      model: { id: toCursorModelId(input.modelId) },
      ...(mergedMcp ? { mcpServers: mergedMcp } : {}),
    });
    process.stderr.write(
      `[mcp-debug:agent.create] created agentId=${agent.agentId}\n`,
    );
    await this.store.set(input.threadId, {
      agentId: agent.agentId,
      mcpSignature: computeMcpSignature(input.mcpServers),
    });
    return { agent, createdFresh: true };
  }
}


/**
 * Stable identity of an `mcpServers` map. Just the sorted provider names
 * joined with `,`. Empty string for "no MCP". Tokens / URLs / headers are
 * NOT in the signature — token rotation must not force agent recreation.
 */
function computeMcpSignature(
  mcpServers: Record<string, unknown> | undefined,
): string {
  if (!mcpServers) return "";
  const keys = Object.keys(mcpServers);
  if (keys.length === 0) return "";
  return [...keys].sort().join(",");
}

function mergeMcp(
  a: Record<string, McpServerConfig> | undefined,
  b: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!a && !b) return undefined;
  return { ...(a ?? {}), ...(b ?? {}) };
}

/**
 * Render the messages that precede the just-arrived user message into a
 * single text block. The fresh-agent-per-turn strategy means cloud-side
 * conversation context is gone; we restore it by prepending this block
 * to the user message body.
 */
function buildPriorConversationBlock(
  messages: readonly AgentMessage[],
): string | null {
  if (messages.length <= 1) return null;
  const prior = messages.slice(0, -1);
  const lines: string[] = ["[Prior conversation]"];
  for (const m of prior) {
    const label =
      m.role === "user"
        ? "User"
        : m.role === "assistant"
          ? "Assistant"
          : "Tool";
    lines.push(`${label}: ${m.content}`);
  }
  lines.push("[End prior conversation]");
  return lines.join("\n");
}

/**
 * Map a single Cursor SDK stream message onto zero or more `AgentEvent`s.
 *
 * - `assistant` → emit `text-delta` for each text block. Tool-use blocks
 *   inside an assistant message are skipped because the SDK also surfaces
 *   them as standalone `tool_call` messages, which carry richer status.
 * - `tool_call` (running) → `tool-call`.
 * - `tool_call` (completed | error) → `tool-result`.
 * - everything else (system / user echo / thinking / status / request / task)
 *   is dropped: the web layer doesn't render those today.
 */
function* mapSdkMessage(m: SDKMessage): Generator<AgentEvent, void> {
  switch (m.type) {
    case "assistant": {
      for (const block of m.message.content) {
        if (block.type === "text" && block.text) {
          yield { type: "text-delta", delta: block.text };
        }
      }
      return;
    }
    case "tool_call": {
      if (m.status === "running") {
        yield {
          type: "tool-call",
          call: {
            id: m.call_id,
            name: m.name,
            input: toRecord(m.args),
          },
        };
      } else {
        yield {
          type: "tool-result",
          result: {
            toolCallId: m.call_id,
            output: m.result,
            isError: m.status === "error",
          },
        };
      }
      return;
    }
    default:
      return;
  }
}

function lastUserText(messages: readonly AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user" && msg.content) return msg.content;
  }
  return undefined;
}

function toMcpRecord(
  stubs: readonly McpServerConfigStub[] | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!stubs?.length) return undefined;
  const out: Record<string, McpServerConfig> = {};
  for (const s of stubs) {
    if (s.command) {
      out[s.name] = {
        type: "stdio",
        command: s.command,
        ...(s.args ? { args: [...s.args] } : {}),
        ...(s.env ? { env: s.env } : {}),
      };
    } else if (s.url) {
      out[s.name] = { type: "http", url: s.url };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err == null) return "unknown error";
  return String(err);
}

/**
 * Stream-level diagnostic. Logs every tool_call (running / completed /
 * error) so we can see which MCP tools were attempted and what they
 * returned, plus every non-RUNNING status message — covers both the
 * "tool result with isError" failure mode and SDK-level status errors.
 * Result payloads are truncated at 8KB to stay well under CloudWatch's
 * 256KB per-event limit while still capturing typical MCP error bodies.
 */
function logSdkMessage(
  m: SDKMessage,
  threadId: string,
  agentId: string,
): void {
  if (m.type === "tool_call") {
    const isError = m.status === "error";
    const payload: Record<string, unknown> = {
      threadId,
      agentId,
      callId: m.call_id,
      name: m.name,
      status: m.status,
    };
    if (m.truncated) payload.truncated = m.truncated;
    if (m.status !== "running") {
      payload.result = truncateJson(m.result, 8000);
    }
    const tag = isError ? "tool-error" : "tool-call";
    process.stderr.write(
      `[mcp-debug:${tag}] ${JSON.stringify(payload)}\n`,
    );
    return;
  }
  if (m.type === "status" && m.status !== "RUNNING") {
    process.stderr.write(
      `[mcp-debug:status] ${JSON.stringify({
        threadId,
        agentId,
        status: m.status,
        message: m.message,
      })}\n`,
    );
    return;
  }
}

function truncateJson(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length <= maxChars) return value;
  return { __truncated: true, length: s.length, preview: s.slice(0, maxChars) };
}

function logRuntimeError(
  site: "getOrCreateAgent" | "send" | "stream",
  threadId: string,
  err: unknown,
  extra: Record<string, unknown> = {},
): void {
  const stack = err instanceof Error ? err.stack : undefined;
  const name = err instanceof Error ? err.name : undefined;
  process.stderr.write(
    `[cursor-runtime-error:${site}] ${JSON.stringify({
      threadId,
      name,
      message: errorMessage(err),
      stack,
      ...extra,
    })}\n`,
  );
}

// Translate caller's modelId for the Cursor SDK. The web app's /api/models
// endpoint now sources its list from Cursor.models.list() directly, so the
// id arriving here is typically already a Cursor id and should pass through.
// Older threads / older localStorage may still carry our legacy short ids
// (haiku-4-5 / sonnet-4-6 / opus-4-7) — the LEGACY_MAP upgrades those.
// Anything else is forwarded as-is; the SDK rejects unknown ids at send-time.
function toCursorModelId(modelId: string): string {
  const LEGACY_MAP: Record<string, string> = {
    "haiku-4-5": "claude-haiku-4-5-20251001",
    "sonnet-4-6": "claude-sonnet-4-6",
    "opus-4-7": "claude-opus-4-7",
  };
  return LEGACY_MAP[modelId] ?? modelId;
}

/**
 * In-memory `ThreadAgentStore` for tests and the dev loop. Step 4 swaps in
 * a `chat_threads.cursor_agent_id`-backed store so agents survive restarts.
 */
export class InMemoryThreadAgentStore implements ThreadAgentStore {
  private readonly map = new Map<string, ThreadAgentRecord>();
  async get(threadId: string): Promise<ThreadAgentRecord | null> {
    return this.map.get(threadId) ?? null;
  }
  async set(threadId: string, record: ThreadAgentRecord): Promise<void> {
    this.map.set(threadId, record);
  }
  async clear(threadId: string): Promise<void> {
    this.map.delete(threadId);
  }
}
