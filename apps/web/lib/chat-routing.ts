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
  priorUserMessages = [],
}: {
  message: string;
  executionMode?: unknown;
  runtimeV2?: boolean;
  /**
   * Earlier user turns in the same thread (most-recent first is fine; order
   * doesn't matter). Used for conversation-level tool stickiness — see the
   * fall-through below.
   */
  priorUserMessages?: readonly string[];
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

  // Conversation-level tool stickiness. This message on its own doesn't warrant
  // tools, but if an earlier turn in the thread did, keep them mounted. Without
  // this, a follow-up like "what repos did you check?" (no tool keywords) drops
  // to the tool-less fast lane and the model contradicts the turn that just used
  // tools — answering "I don't have access to GitHub" one turn after reading it.
  // Upgrade fast→tool only (never force the durable worker on a follow-up).
  if (threadAlreadyUsedTools(priorUserMessages)) {
    reasons.push("sticky_tool_thread");
    return {
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      runtimeV2,
      useWorker: false,
      useMcp: true,
      includeVaultContext: personalContext !== null,
      reasons,
    };
  }

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

/**
 * True when any earlier user turn in the thread needed connected tools (a tool
 * lookup or durable code work). Once a conversation is "about" GitHub, follow-up
 * questions should keep the tools warm rather than re-deciding from keywords.
 */
function threadAlreadyUsedTools(priorUserMessages: readonly string[]): boolean {
  return priorUserMessages.some((prior) => {
    const n = normalize(prior);
    return hasToolIntent(n) !== null || hasDurableIntent(n) !== null;
  });
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
    /\b(run|write|add|update|create|make)\b/.test(value) &&
    /\b(tests?|migration|pull request|pr|branch|commit|files?|component|endpoint|api route)\b/.test(
      value,
    )
  ) {
    return "durable_code_change";
  }
  if (
    /\b(create|draft)\b.*\b(pull request|pr)\b/.test(value) ||
    (/\bopen\s+(a\s+)?(pull request|pr)\b/.test(value) &&
      !hasNumberedGithubReference(value))
  ) {
    return "pull_request_work";
  }
  return null;
}

function hasToolIntent(value: string): string | null {
  if (hasNumberedGithubReference(value)) {
    return "github_numbered_reference";
  }
  if (hasCiStatusLookup(value)) {
    return "github_ci_status_lookup";
  }
  if (hasOwnedGithubWorkLookup(value)) {
    return "github_owned_work_lookup";
  }
  if (hasRecentGithubWorkLookup(value)) {
    return "github_recent_work_lookup";
  }
  if (
    /\b(github|gh|repo|repository)\b/.test(value) &&
    GITHUB_LOOKUP_ACTION_RE.test(value)
  ) {
    return "github_provider_lookup";
  }
  if (
    /\b(pull request|prs?|commit|branch|workflow|actions|ci)\b/.test(value) &&
    GITHUB_LOOKUP_ACTION_RE.test(value)
  ) {
    return "github_resource_lookup";
  }
  if (/\bmy\s+(repo|repository|github|gh|issues?|prs?|pull requests?)\b/.test(value)) {
    return "github_owned_resource";
  }
  return null;
}

const GITHUB_LOOKUP_ACTION_RE =
  /\b(check|inspect|look|peek|find|search|list|read|show|summarize|compare|status|review|open|create|update|comment|close|merge)\b/;

function hasNumberedGithubReference(value: string): boolean {
  return /\b(issue|pull request|pr)\s*#?\d+\b/.test(value);
}

function hasCiStatusLookup(value: string): boolean {
  return (
    /\b(anything|checks?|status|failing|failed|broken|red|green|passing|queued|pending)\b.*\b(ci|actions?|workflows?|checks?)\b/.test(
      value,
    ) ||
    /\b(ci|actions?|workflows?|checks?)\b.*\b(anything|status|failing|failed|broken|red|green|passing|queued|pending)\b/.test(
      value,
    )
  );
}

function hasOwnedGithubWorkLookup(value: string): boolean {
  return (
    hasOwnershipContext(value) &&
    /\b(pull requests?|prs?|issues?|commits?|branches?|workflows?|actions|ci|repos?|repositories?)\b/.test(
      value,
    ) &&
    /\b(last|latest|recent|open|stale|assigned|reviewing|review|failing|failed|passing|status|summarize|list|show|what|which|anything)\b/.test(
      value,
    )
  );
}

function hasOwnershipContext(value: string): boolean {
  return (
    /\b(my|mine|our|ours|we|team)\b/.test(value) ||
    /\b(am i|i am|i'm|assigned to me|for me)\b/.test(value)
  );
}

function hasRecentGithubWorkLookup(value: string): boolean {
  return /\b(last|latest|recent|open|stale|failing|failed|merged|pending)\b(?:\W+\w+){0,4}\W+\b(pull requests?|prs?|commits?|branches?|workflows?|actions|ci)\b/.test(
    value,
  );
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
