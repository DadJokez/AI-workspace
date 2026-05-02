import type { AgentEvent } from "@ai-workspace/agent";

// Real package — confirmed on npm 2026-05-02 as @cursor/sdk@1.0.12 (Anysphere).
// Spike imports are commented out until we wire a live integration: pulling
// the SDK in adds a ~12 MB native dep (sqlite3) and a runtime auth requirement
// (`CURSOR_API_KEY`), and we don't want either gating `pnpm install` until the
// promotion conversation. Real surface, per the SDK's `dist/esm/stubs.d.ts`:
//
//   import { Agent, Cursor } from "@cursor/sdk";
//   const agent = await Agent.create({ model: { id: "..." }, ... });
//   const run = await agent.send("hello", { mcpServers: [...] });
//   for await (const m of run.stream()) { ... }
//
// `Agent.resume(agentId)` rehydrates a durable agent across processes, which
// is what makes this a real "runtime" rather than another stateless client.

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
 *      See `packages/mcp-servers/` for the placeholder structure.
 *   3. Policy via `.cursor/hooks.json`. Pre/post-tool hooks intercept the
 *      run; the SDK respects the hook config without app-level plumbing.
 *
 * SPIKE-ONLY: this class compiles without the SDK installed at runtime.
 * Methods throw a clear error if invoked. Promote by:
 *   - uncommenting the `@cursor/sdk` import
 *   - implementing the body of `getOrCreateAgent` and `runTurn`
 *   - adding `CURSOR_API_KEY` to env validation
 *   - persisting the `threadId → agentId` mapping (likely a column on
 *     `chat_threads`, e.g. `cursor_agent_id text`)
 */
export interface CursorRuntimeOptions {
  /** Cursor API key. Required when `runTurn` is actually invoked. */
  apiKey?: string;
  /**
   * Maps our logical thread id to a persisted Cursor `agentId`. The real impl
   * reads/writes a column on `chat_threads`; the spike accepts an in-memory
   * Map for testability.
   */
  threadAgentStore?: ThreadAgentStore;
  /**
   * MCP server configs to pass to `Agent.create({ mcpServers: [...] })`.
   * Lives here, not in the runtime contract, because Bedrock doesn't have
   * an analogue.
   */
  mcpServers?: McpServerConfigStub[];
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

  constructor(opts: CursorRuntimeOptions = {}) {
    this.opts = opts;
  }

  // eslint-disable-next-line require-yield
  async *runTurn(_input: TurnInput): AsyncIterable<AgentEvent> {
    // Sketch of the real implementation:
    //
    //   const agentId = await this.opts.threadAgentStore?.get(input.threadId);
    //   const agent = agentId
    //     ? await Agent.resume(agentId, { apiKey: this.opts.apiKey })
    //     : await Agent.create({
    //         apiKey: this.opts.apiKey,
    //         model: { id: mapModelId(input.modelId) },
    //         systemPrompt: input.systemPrompt,
    //         mcpServers: this.opts.mcpServers,
    //       });
    //   if (!agentId) {
    //     await this.opts.threadAgentStore?.set(input.threadId, agent.agentId);
    //   }
    //
    //   const lastUser = lastUserMessage(input.messages);
    //   const run = await agent.send(lastUser, { signal: input.signal });
    //   for await (const m of run.stream()) {
    //     yield* mapSdkMessageToAgentEvents(m);
    //   }
    //   const result = await run.wait();
    //   yield { type: "usage", tokensIn: result.usage.input, tokensOut: result.usage.output };
    //   yield { type: "done" };

    throw new Error(
      "CursorRuntime.runTurn: spike-only stub. Promote by uncommenting the " +
        "`@cursor/sdk` import in cursor-runtime.ts and implementing the body. " +
        "See SPIKE.md for the promotion checklist.",
    );
  }
}

/**
 * In-memory `ThreadAgentStore` for tests and the dev loop. The real
 * implementation reads/writes `chat_threads.cursor_agent_id`.
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
