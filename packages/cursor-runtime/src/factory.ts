import type { Database } from "@ai-workspace/db";

import { BedrockRuntime } from "./bedrock-runtime";
import { CursorRuntime } from "./cursor-runtime";
import { DbThreadAgentStore } from "./db-thread-agent-store";
import type { AgentRuntime, RuntimeName } from "./types";

const VALID_RUNTIMES: readonly RuntimeName[] = ["bedrock", "cursor"];

export interface GetRuntimeOptions {
  /**
   * Drizzle db client. When `RUNTIME=cursor`, this is used to construct a
   * `DbThreadAgentStore` so `threadId → agentId` survives process restarts.
   * Optional for `bedrock` (which is stateless).
   */
  db?: Database;
}

/**
 * Resolve the active runtime from `process.env.RUNTIME`. Defaults to
 * `cursor`. Set `RUNTIME=bedrock` to use Bedrock instead.
 *
 * The whole point of this seam: swapping the runtime is one env var, no
 * route-handler changes. `apps/web/app/api/chat/route.ts` only ever sees
 * `AgentRuntime`.
 */
export function getRuntime(opts: GetRuntimeOptions = {}): AgentRuntime {
  const raw = (process.env.RUNTIME ?? "cursor").toLowerCase();
  if (!isValidRuntime(raw)) {
    throw new Error(
      `Unknown RUNTIME='${raw}'. Expected one of: ${VALID_RUNTIMES.join(", ")}.`,
    );
  }
  if (raw === "bedrock") return new BedrockRuntime();
  return new CursorRuntime({
    apiKey: process.env.CURSOR_API_KEY,
    ...(opts.db ? { threadAgentStore: new DbThreadAgentStore(opts.db) } : {}),
  });
}

function isValidRuntime(s: string): s is RuntimeName {
  return (VALID_RUNTIMES as readonly string[]).includes(s);
}
