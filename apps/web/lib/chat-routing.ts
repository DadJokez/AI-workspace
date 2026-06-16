import type { ChatExecutionMode } from "@/lib/chat-execution-mode";

export type ChatRuntimeLane =
  | "fast-local"
  | "tool-local"
  | "durable-local";

export type ChatRuntimeTarget =
  | "direct-chat"
  | "bedrock-agent"
  | "agentcore-worker";

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

export interface ChatRoutingContextSignals {
  priorUserMessagesCount?: number;
  vaultMemoryAvailable?: boolean;
  artifactContextAvailable?: boolean;
  uploadedFilesAvailable?: boolean;
}

export interface ChatRoutingCapabilitySignals {
  connectedProviders?: readonly string[];
  approvedProviders?: readonly string[];
  pendingApprovalProviders?: readonly string[];
  recommendedEscalation?: {
    lane: Exclude<ChatRuntimeLane, "fast-local">;
    reason: string;
  };
}

export interface ChatRouteReceipt {
  lane: ChatRuntimeLane;
  runtimeTarget: ChatRuntimeTarget;
  useWorker: boolean;
  useMcp: boolean;
  includeVaultContext: boolean;
  reasons: string[];
  explanation: string;
  contextAvailability: {
    priorUserMessages: number;
    vaultMemoryAvailable: boolean;
    artifactContextAvailable: boolean;
    uploadedFilesAvailable: boolean;
  };
  toolAvailability: {
    connectedProviders: string[];
    approvedProviders: string[];
    pendingApprovalProviders: string[];
  };
}

export function decideChatRuntimeRoute({
  message,
  runtimeV2 = false,
  priorUserMessages = [],
  contextSignals = {},
  capabilitySignals = {},
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
  contextSignals?: ChatRoutingContextSignals;
  capabilitySignals?: ChatRoutingCapabilitySignals;
}): ChatRuntimeRoute {
  const normalized = normalize(message);
  const reasons: string[] = [];

  if (capabilitySignals.recommendedEscalation?.lane === "durable-local") {
    reasons.push("recommended_durable_escalation");
    reasons.push(capabilitySignals.recommendedEscalation.reason);
    return {
      lane: "durable-local",
      executionMode: "local",
      runtimeTarget: "agentcore-worker",
      runtimeV2,
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons,
    };
  }

  const durable = hasDurableIntent(normalized);
  if (durable) reasons.push(durable);
  if (durable) {
    return {
      lane: "durable-local",
      executionMode: "local",
      runtimeTarget: "agentcore-worker",
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
      runtimeTarget: "bedrock-agent",
      runtimeV2,
      useWorker: false,
      useMcp: true,
      includeVaultContext:
        hasPersonalContextIntent(normalized) !== null ||
        contextSignals.vaultMemoryAvailable === true,
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
      runtimeTarget: "bedrock-agent",
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
    runtimeTarget: "direct-chat",
    runtimeV2,
    useWorker: false,
    useMcp: false,
    includeVaultContext: personalContext !== null,
    reasons: reasons.length > 0 ? reasons : ["default_fast_local"],
  };
}

export function buildChatRouteReceipt({
  route,
  contextSignals = {},
  capabilitySignals = {},
}: {
  route: ChatRuntimeRoute;
  contextSignals?: ChatRoutingContextSignals;
  capabilitySignals?: ChatRoutingCapabilitySignals;
}): ChatRouteReceipt {
  return {
    lane: route.lane,
    runtimeTarget: route.runtimeTarget,
    useWorker: route.useWorker,
    useMcp: route.useMcp,
    includeVaultContext: route.includeVaultContext,
    reasons: [...route.reasons],
    explanation: explainRoute(route),
    contextAvailability: {
      priorUserMessages: contextSignals.priorUserMessagesCount ?? 0,
      vaultMemoryAvailable: contextSignals.vaultMemoryAvailable === true,
      artifactContextAvailable: contextSignals.artifactContextAvailable === true,
      uploadedFilesAvailable: contextSignals.uploadedFilesAvailable === true,
    },
    toolAvailability: {
      connectedProviders: uniqueStrings(capabilitySignals.connectedProviders ?? []),
      approvedProviders: uniqueStrings(capabilitySignals.approvedProviders ?? []),
      pendingApprovalProviders: uniqueStrings(
        capabilitySignals.pendingApprovalProviders ?? [],
      ),
    },
  };
}

export function applyActivatedSkillRoute(
  route: ChatRuntimeRoute,
  {
    requiredProviders = [],
  }: {
    requiredProviders?: readonly string[];
  } = {},
): ChatRuntimeRoute {
  const reasons = uniqueStrings([
    ...route.reasons,
    "explicit_skill_activation",
    ...(requiredProviders.length > 0 ? ["activated_skill_requires_tools"] : []),
  ]);

  if (route.useWorker) {
    return {
      ...route,
      useMcp: route.useMcp || requiredProviders.length > 0,
      includeVaultContext: true,
      reasons,
    };
  }

  if (requiredProviders.length > 0) {
    return {
      ...route,
      lane: "tool-local",
      runtimeTarget: "bedrock-agent",
      useMcp: true,
      includeVaultContext: true,
      reasons,
    };
  }

  return {
    ...route,
    includeVaultContext: true,
    reasons,
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
  if (hasGithubCapabilityProbe(value)) {
    return "github_capability_probe";
  }
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
    (hasGithubName(value) || /\b(repos?|repositories?)\b/.test(value)) &&
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
  if (
    /\bmy\s+(repos?|repositories?|github|gh|issues?|prs?|pull requests?)\b/.test(
      value,
    )
  ) {
    return "github_owned_resource";
  }
  return null;
}

const GITHUB_LOOKUP_ACTION_RE =
  /\b(check|inspect|look|peek|find|search|list|read|show|see|view|summarize|compare|status|review|open|create|update|comment|close|merge|try)\b/;

function hasGithubName(value: string): boolean {
  return /\b(github|gh|git hub)\b/.test(value);
}

function hasGithubCapabilityProbe(value: string): boolean {
  if (
    hasGithubName(value) &&
    /\b(access|connected|connect|available|tool|tools|wired|see|view|try)\b/.test(
      value,
    )
  ) {
    return true;
  }
  return (
    /\btools?\b.*\bconnected\b/.test(value) &&
    /\b(repos?|repositories?|github|gh|git hub)\b/.test(value)
  );
}

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
    /\b(remember|memory|vault|personal context|based on what you know|based on my context|my preferences|my style|my priorities)\b/.test(
      value,
    )
  ) {
    return "personal_context_intent";
  }
  if (
    /\bwhat (do you know|context do you have|context is available|context are you using)\b/.test(
      value,
    ) &&
    /\b(me|my|about me|for me)\b/.test(value)
  ) {
    return "personal_context_intent";
  }
  if (
    /\bwhat do you know about (me|my job|my role|my team|my work|my priorities|my company)\b/.test(
      value,
    )
  ) {
    return "personal_context_intent";
  }
  if (
    /\b(what'?s|what is|do you know|tell me)\s+my\s+name\b/.test(value) ||
    /\bwho am i\b/.test(value) ||
    /\b(what'?s|what is|do you know|tell me)\s+my\s+(job|role|team|title|company)\b/.test(
      value,
    )
  ) {
    return "personal_context_intent";
  }
  if (
    /\bwhat should i focus on\b/.test(value) ||
    /\bwhat (are|should be) my priorities\b/.test(value) ||
    /\bwhat matters most for me\b/.test(value)
  ) {
    return "personal_context_intent";
  }
  return null;
}

function explainRoute(route: ChatRuntimeRoute): string {
  if (route.lane === "durable-local") {
    return "Queued durable local work because this request needs resilient, longer-running execution.";
  }
  if (route.lane === "tool-local") {
    return "Mounted local tools because this request needs live connected-system data or follows a tool-backed thread.";
  }
  if (route.includeVaultContext) {
    return "Used fast local chat with Vault context because this request asks for personal or profile context.";
  }
  return "Used fast local chat because no live tools or durable worker were needed.";
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
