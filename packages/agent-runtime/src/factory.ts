import { AgentCoreRuntime } from "./agentcore-runtime";
import { BedrockRuntime } from "./bedrock-runtime";
import {
  BUILT_IN_RUNTIME_NAMES,
  type AgentRuntime,
  type RuntimeName,
} from "./types";

/** Adapters registered at runtime, keyed by lower-cased name. */
const registeredRuntimes = new Map<string, () => AgentRuntime>();

export interface GetRuntimeOptions {
  /**
   * Optional per-run runtime override. When omitted, falls back to RUNTIME for
   * backwards compatibility.
   */
  runtime?: RuntimeName;
}

/**
 * Register a runtime adapter so `getRuntime({ runtime: name })` and
 * `RUNTIME=<name>` can select it — no edit to `RuntimeName` or the SSE relay
 * (#797 P1). Built-in names are reserved and a name registers once; the
 * returned function unregisters it (tests, hot-swap).
 */
export function registerRuntime(
  name: RuntimeName,
  create: () => AgentRuntime,
): () => void {
  const key = name.toLowerCase();
  if (isBuiltInRuntime(key)) {
    throw new Error(`Runtime '${key}' is built in and cannot be re-registered.`);
  }
  if (registeredRuntimes.has(key)) {
    throw new Error(`Runtime '${key}' is already registered.`);
  }
  registeredRuntimes.set(key, create);
  return () => {
    registeredRuntimes.delete(key);
  };
}

/**
 * Resolve the active runtime from `process.env.RUNTIME`. Defaults to direct
 * Bedrock. Set `RUNTIME=agentcore` for the AWS-hosted worker lane, or the
 * name of any adapter added via `registerRuntime`.
 *
 * The whole point of this seam: swapping the runtime is one env var, no
 * route-handler changes. `apps/web/app/api/chat/route.ts` only ever sees
 * `AgentRuntime`.
 */
export function getRuntime(opts: GetRuntimeOptions = {}): AgentRuntime {
  const raw = (opts.runtime ?? process.env.RUNTIME ?? "bedrock").toLowerCase();
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

  const create = registeredRuntimes.get(raw);
  if (!create) {
    const known = [...BUILT_IN_RUNTIME_NAMES, ...registeredRuntimes.keys()];
    throw new Error(
      `Unknown runtime='${raw}'. Expected one of: ${known.join(", ")}.`,
    );
  }
  const runtime = create();
  // Logs, telemetry, and run metadata trust `runtime.name`; an adapter that
  // answers to one name and reports another would misattribute every run.
  if (runtime.name.toLowerCase() !== raw) {
    throw new Error(
      `Runtime registered as '${raw}' reports name '${runtime.name}'.`,
    );
  }
  return runtime;
}

function isBuiltInRuntime(s: string): boolean {
  return (BUILT_IN_RUNTIME_NAMES as readonly string[]).includes(s);
}
