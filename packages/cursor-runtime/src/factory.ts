import { BedrockRuntime } from "./bedrock-runtime";
import { CursorRuntime } from "./cursor-runtime";
import type { AgentRuntime, RuntimeName } from "./types";

const VALID_RUNTIMES: readonly RuntimeName[] = ["bedrock", "cursor"];

/**
 * Resolve the active runtime from `process.env.RUNTIME`. Defaults to
 * `bedrock` so existing dev loops keep working when this env var is unset.
 *
 * The whole point of this seam: swapping the runtime is one env var, no
 * route-handler changes. `apps/web/app/api/chat/route.ts` (when it gets
 * wired) only ever sees `AgentRuntime`.
 */
export function getRuntime(): AgentRuntime {
  const raw = (process.env.RUNTIME ?? "bedrock").toLowerCase();
  if (!isValidRuntime(raw)) {
    throw new Error(
      `Unknown RUNTIME='${raw}'. Expected one of: ${VALID_RUNTIMES.join(", ")}.`,
    );
  }
  if (raw === "bedrock") return new BedrockRuntime();
  return new CursorRuntime({ apiKey: process.env.CURSOR_API_KEY });
}

function isValidRuntime(s: string): s is RuntimeName {
  return (VALID_RUNTIMES as readonly string[]).includes(s);
}
