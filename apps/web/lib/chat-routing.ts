import {
  parseChatExecutionMode,
  type ChatExecutionMode,
} from "@/lib/chat-execution-mode";

export type ChatRuntimeLane =
  | "fast-local"
  | "tool-local"
  | "durable-local"
  | "cursor-cloud";

export type ChatRuntimeTarget = "direct-chat" | "cursor-agent";

export interface ChatRuntimeRoute {
  lane: ChatRuntimeLane;
  executionMode: ChatExecutionMode;
  runtimeTarget: ChatRuntimeTarget;
  runtimeV2: boolean;
  useWorker: boolean;
  useMcp: boolean;
  includeVaultContext: boolean;
  reasons: string[];
}

export function decideChatRuntimeRoute({
  message,
  executionMode,
  runtimeV2 = false,
}: {
  message: string;
  executionMode?: unknown;
  runtimeV2?: boolean;
}): ChatRuntimeRoute {
  const parsedExecutionMode = parseChatExecutionMode(executionMode);
  const normalized = normalize(message);
  const reasons: string[] = [];

  if (parsedExecutionMode === "cloud") {
    return {
      lane: "cursor-cloud",
      executionMode: "cloud",
      runtimeTarget: "cursor-agent",
      runtimeV2,
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons: ["explicit_cloud"],
    };
  }

  const durable = hasDurableIntent(normalized);
  if (durable) reasons.push(durable);
  if (durable) {
    return {
      lane: "durable-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      runtimeV2,
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons,
    };
  }

  const tool = hasToolIntent(normalized);
  if (tool) reasons.push(tool);
  if (tool) {
    return {
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      runtimeV2,
      useWorker: false,
      useMcp: true,
      includeVaultContext: hasPersonalContextIntent(normalized) !== null,
      reasons,
    };
  }

  const personalContext = hasPersonalContextIntent(normalized);
  if (personalContext) reasons.push(personalContext);

  return {
    lane: "fast-local",
    executionMode: "local",
    runtimeTarget: runtimeV2 ? "direct-chat" : "cursor-agent",
    runtimeV2,
    useWorker: false,
    useMcp: false,
    includeVaultContext: personalContext !== null,
    reasons: reasons.length > 0 ? reasons : ["default_fast_local"],
  };
}

export function runtimeV2EnabledFromEnv(
  value = process.env.RUNTIME_V2_ENABLED,
): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasDurableIntent(value: string): string | null {
  if (/\b(keep working|background|long[- ]?running|async|overnight)\b/.test(value)) {
    return "explicit_durable_work";
  }
  if (
    /\b(implement|build|ship|deploy|migrate|refactor|debug|fix|repair|investigate|audit)\b/.test(
      value,
    ) &&
    /\b(app|site|feature|bug|repo|repository|codebase|tests?|ci|ecs|fargate|infra|stack|pipeline|worker|database|db)\b/.test(
      value,
    )
  ) {
    return "implementation_work";
  }
  if (
    /\b(run|write|add|update|create|open|make)\b/.test(value) &&
    /\b(tests?|migration|pull request|pr|branch|commit|files?|component|endpoint|api route)\b/.test(
      value,
    )
  ) {
    return "durable_code_change";
  }
  if (/\b(open|create|draft)\b.*\b(pull request|pr)\b/.test(value)) {
    return "pull_request_work";
  }
  return null;
}

function hasToolIntent(value: string): string | null {
  if (
    /\b(github|gh|repo|repository|issue|pull request|prs?|commit|branch|workflow|actions|ci)\b/.test(
      value,
    ) &&
    /\b(check|inspect|look|peek|find|search|list|read|show|summarize|compare|open|create|update|comment|close|merge)\b/.test(
      value,
    )
  ) {
    return "github_tool_intent";
  }
  if (/\b(issue|pull request|prs?)\s*#?\d+\b/.test(value)) {
    return "github_reference";
  }
  if (/\bmy\s+(repo|repository|github|gh|issues?|prs?|pull requests?)\b/.test(value)) {
    return "github_owned_resource";
  }
  return null;
}

function hasPersonalContextIntent(value: string): string | null {
  if (
    /\b(remember|memory|vault|personal context|what do you know about me|based on what you know|my preferences|my style|my priorities)\b/.test(
      value,
    )
  ) {
    return "personal_context_intent";
  }
  return null;
}
