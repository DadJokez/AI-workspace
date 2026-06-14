import { AgentCoreRuntime } from "./agentcore-runtime";
import { BedrockRuntime } from "./bedrock-runtime";
import type { AgentRuntime, RuntimeName } from "./types";

const VALID_RUNTIMES: readonly RuntimeName[] = ["bedrock", "agentcore"];

export interface GetRuntimeOptions {
  /**
   * Optional per-run runtime override. When omitted, falls back to RUNTIME for
   * backwards compatibility.
   */
  runtime?: RuntimeName;
}

/**
 * Resolve the active runtime from `process.env.RUNTIME`. Defaults to direct
 * Bedrock. Set `RUNTIME=agentcore` for the AWS-hosted worker lane.
 *
 * The whole point of this seam: swapping the runtime is one env var, no
 * route-handler changes. `apps/web/app/api/chat/route.ts` only ever sees
 * `AgentRuntime`.
 */
export function getRuntime(opts: GetRuntimeOptions = {}): AgentRuntime {
  const raw = (opts.runtime ?? process.env.RUNTIME ?? "bedrock").toLowerCase();
  if (!isValidRuntime(raw)) {
    throw new Error(
      `Unknown runtime='${raw}'. Expected one of: ${VALID_RUNTIMES.join(", ")}.`,
    );
  }
  if (raw === "bedrock") return new BedrockRuntime();
  if (raw === "agentcore") {
    const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN;
    if (!runtimeArn) {
      throw new Error(
        "RUNTIME=agentcore requires AGENTCORE_RUNTIME_ARN to be set.",
      );
    }
    return new AgentCoreRuntime({
      runtimeArn,
      region: process.env.AGENTCORE_REGION ?? process.env.AWS_REGION,
      qualifier: process.env.AGENTCORE_QUALIFIER,
    });
  }

  throw new Error(`Unhandled runtime='${raw}'.`);
}

function isValidRuntime(s: string): s is RuntimeName {
  return (VALID_RUNTIMES as readonly string[]).includes(s);
}
