import type { Database } from "@ai-workspace/db";
import type { CloudAgentOptions } from "@cursor/sdk";

import { AgentCoreRuntime } from "./agentcore-runtime";
import { BedrockRuntime } from "./bedrock-runtime";
import { CursorRuntime, type CursorExecutionMode } from "./cursor-runtime";
import { DbThreadAgentStore } from "./db-thread-agent-store";
import type { AgentRuntime, RuntimeName } from "./types";

const VALID_RUNTIMES: readonly RuntimeName[] = [
  "bedrock",
  "cursor",
  "agentcore",
];

export interface GetRuntimeOptions {
  /**
   * Drizzle db client. When `RUNTIME=cursor`, this is used to construct a
   * `DbThreadAgentStore` so `threadId → agentId` survives process restarts.
   * Optional for `bedrock` (which is stateless).
   */
  db?: Database;
  /**
   * Optional per-run Cursor execution mode. When omitted, falls back to
   * CURSOR_RUNTIME_MODE for backwards compatibility.
   */
  executionMode?: CursorExecutionMode;
  /**
   * Optional per-run runtime override. When omitted, falls back to RUNTIME for
   * backwards compatibility.
   */
  runtime?: RuntimeName;
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
  const raw = (opts.runtime ?? process.env.RUNTIME ?? "cursor").toLowerCase();
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
  const executionMode =
    opts.executionMode ??
    parseCursorExecutionMode(process.env.CURSOR_RUNTIME_MODE);
  return new CursorRuntime({
    apiKey: process.env.CURSOR_API_KEY,
    executionMode,
    ...(executionMode === "cloud"
      ? { cloud: buildCursorCloudOptionsFromEnv() }
      : {}),
    ...(opts.db ? { threadAgentStore: new DbThreadAgentStore(opts.db) } : {}),
  });
}

function isValidRuntime(s: string): s is RuntimeName {
  return (VALID_RUNTIMES as readonly string[]).includes(s);
}

function parseCursorExecutionMode(
  value: string | undefined,
): CursorExecutionMode {
  const raw = (value ?? "local").toLowerCase();
  if (raw === "cloud" || raw === "local") return raw;
  throw new Error(
    `Unknown CURSOR_RUNTIME_MODE='${value}'. Expected 'local' or 'cloud'.`,
  );
}

function buildCursorCloudOptionsFromEnv(): CloudAgentOptions {
  const repoUrl = trimEnv("CURSOR_CLOUD_REPO_URL");
  const startingRef = trimEnv("CURSOR_CLOUD_REPO_REF");
  const envType = parseCursorCloudEnvType(process.env.CURSOR_CLOUD_ENV_TYPE);
  const envName = trimEnv("CURSOR_CLOUD_ENV_NAME");

  return {
    env: {
      type: envType,
      ...(envName ? { name: envName } : {}),
    },
    ...(repoUrl
      ? {
          repos: [
            {
              url: repoUrl,
              ...(startingRef ? { startingRef } : {}),
            },
          ],
        }
      : {}),
    ...(booleanEnv("CURSOR_CLOUD_WORK_ON_CURRENT_BRANCH") !== undefined
      ? {
          workOnCurrentBranch: booleanEnv(
            "CURSOR_CLOUD_WORK_ON_CURRENT_BRANCH",
          ),
        }
      : {}),
    ...(booleanEnv("CURSOR_CLOUD_AUTO_CREATE_PR") !== undefined
      ? { autoCreatePR: booleanEnv("CURSOR_CLOUD_AUTO_CREATE_PR") }
      : {}),
    ...(booleanEnv("CURSOR_CLOUD_SKIP_REVIEWER_REQUEST") !== undefined
      ? {
          skipReviewerRequest: booleanEnv(
            "CURSOR_CLOUD_SKIP_REVIEWER_REQUEST",
          ),
        }
      : {}),
  };
}

function parseCursorCloudEnvType(
  value: string | undefined,
): "cloud" | "pool" | "machine" {
  const raw = (value ?? "cloud").toLowerCase();
  if (raw === "cloud" || raw === "pool" || raw === "machine") return raw;
  throw new Error(
    `Unknown CURSOR_CLOUD_ENV_TYPE='${value}'. Expected cloud, pool, or machine.`,
  );
}

function trimEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function booleanEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`Invalid boolean env ${name}='${process.env[name]}'.`);
}
