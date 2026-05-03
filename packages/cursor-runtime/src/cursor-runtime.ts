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

/** Read/write the persisted `threadId → cursor agentId` mapping. */
export interface ThreadAgentStore {
  get(threadId: string): Promise<string | null>;
  set(threadId: string, agentId: string): Promise<void>;
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
    try {
      agent = await this.getOrCreateAgent(input);
    } catch (err) {
      yield { type: "error", message: `CursorRuntime: ${errorMessage(err)}` };
      return;
    }

    if (input.signal?.aborted) {
      yield { type: "done" };
      return;
    }

    let run;
    try {
      run = await agent.send(lastUser, {
        model: { id: toCursorModelId(input.modelId) },
      });
    } catch (err) {
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
        yield* mapSdkMessage(m);
      }
    } catch (err) {
      yield { type: "error", message: `CursorRuntime.stream: ${errorMessage(err)}` };
      return;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }

    yield { type: "done" };
  }

  private async getOrCreateAgent(input: TurnInput): Promise<SDKAgent> {
    const existingId = await this.store.get(input.threadId);
    if (existingId) {
      try {
        return await Agent.resume(existingId, { apiKey: this.opts.apiKey });
      } catch (err) {
        if (!isAgentMissingError(errorMessage(err))) throw err;
        // The persisted agent id is stale — Cursor's server no longer has
        // it (deleted, expired, or different account). Fall through to
        // create a fresh agent; the store.set below overwrites the dead
        // id so subsequent turns hit the new agent on the resume path.
      }
    }

    const mcpServers = toMcpRecord(this.opts.mcpServers);
    const agent = await Agent.create({
      apiKey: this.opts.apiKey,
      model: { id: toCursorModelId(input.modelId) },
      ...(mcpServers ? { mcpServers } : {}),
    });
    await this.store.set(input.threadId, agent.agentId);
    return agent;
  }
}

/**
 * Heuristic for "the agent id we have is no longer valid on Cursor's side."
 * The SDK doesn't expose a typed error class for this case yet; match on the
 * error message lenient — better to start a fresh agent session than to keep
 * surfacing the same dead-id error to the user. */
function isAgentMissingError(message: string): boolean {
  return /\bnot[ -]?found\b|\b404\b|no such agent|does not exist/i.test(
    message,
  );
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

// Defer model selection to Cursor's auto-router instead of mapping caller
// ids. The incoming modelId is intentionally ignored for now; reinstate a
// translation table here if the product needs deterministic per-call routing.
function toCursorModelId(_modelId: string): string {
  return "default";
}

/**
 * In-memory `ThreadAgentStore` for tests and the dev loop. Step 4 swaps in
 * a `chat_threads.cursor_agent_id`-backed store so agents survive restarts.
 */
export class InMemoryThreadAgentStore implements ThreadAgentStore {
  private readonly map = new Map<string, string>();
  async get(threadId: string): Promise<string | null> {
    return this.map.get(threadId) ?? null;
  }
  async set(threadId: string, agentId: string): Promise<void> {
    this.map.set(threadId, agentId);
  }
}
