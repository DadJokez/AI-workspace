import type { ChatExecutionMode } from "@/lib/chat-execution-mode";
import type { CapabilityEntry, CapabilityGraph } from "@/lib/capability-graph";

export type ChatRuntimeLane =
  | "fast-local"
  | "tool-local"
  | "durable-local";

/**
 * "regex" survives only in runs persisted before the #364 regex engine was
 * deleted (soaked in production since 2026-07-11); every new route is
 * "model-decided".
 */
export type ChatRoutingMode = "regex" | "model-decided";

export type ChatRuntimeTarget =
  | "direct-chat"
  | "bedrock-agent"
  | "agentcore-worker";

export interface ChatRuntimeRoute {
  lane: ChatRuntimeLane;
  /** Missing only on legacy persisted runs created before #364. */
  routingMode?: ChatRoutingMode;
  executionMode: ChatExecutionMode;
  runtimeTarget: ChatRuntimeTarget;
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
  capabilityAvailability?: ChatRoutingCapabilityAvailability;
  recommendedEscalation?: {
    lane: Exclude<ChatRuntimeLane, "fast-local">;
    reason: string;
  };
}

export interface ChatRoutingCapabilityAvailability {
  providers: number;
  skills: number;
  apps: number;
  schedules: number;
  runnableNow: number;
  needsApproval: number;
}

export interface ChatRouteReceipt {
  lane: ChatRuntimeLane;
  routingMode: ChatRoutingMode;
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
  capabilityAvailability: ChatRoutingCapabilityAvailability;
}

export function decideChatRuntimeRoute({
  message,
  priorUserMessages = [],
  capabilitySignals = {},
  capabilityGraph,
}: {
  message: string;
  executionMode?: unknown;
  /**
   * Earlier user turns in the same thread (most-recent first is fine; order
   * doesn't matter). Used for durable-thread stickiness — see
   * `hasDurableProceedIntent`.
   */
  priorUserMessages?: readonly string[];
  capabilitySignals?: ChatRoutingCapabilitySignals;
  capabilityGraph?: CapabilityGraph;
}): ChatRuntimeRoute {
  const normalized = normalize(message);
  const reasons: string[] = [];
  const resolvedCapabilitySignals = resolveCapabilitySignals(
    capabilitySignals,
    capabilityGraph,
  );

  if (resolvedCapabilitySignals.recommendedEscalation?.lane === "durable-local") {
    reasons.push("recommended_durable_escalation");
    reasons.push(resolvedCapabilitySignals.recommendedEscalation.reason);
    return {
      lane: "durable-local",
      routingMode: "model-decided",
      executionMode: "local",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons,
    };
  }

  const durableFollowUp = hasDurableProceedIntent(normalized, priorUserMessages);
  if (durableFollowUp) {
    reasons.push(durableFollowUp);
    return {
      lane: "durable-local",
      routingMode: "model-decided",
      executionMode: "local",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons,
    };
  }

  const durable = hasDurableIntent(normalized);
  if (durable) {
    reasons.push(durable);
    return {
      lane: "durable-local",
      routingMode: "model-decided",
      executionMode: "local",
      runtimeTarget: "agentcore-worker",
      useWorker: true,
      useMcp: true,
      includeVaultContext: true,
      reasons,
    };
  }

  // #364: mount the stable authorized tool catalog and let the model decide
  // whether the turn needs a tool. (The pre-#364 regex intent engine was
  // deleted after soaking in production — see the ChatRoutingMode note.)
  return {
    lane: "tool-local",
    routingMode: "model-decided",
    executionMode: "local",
    runtimeTarget: "bedrock-agent",
    useWorker: false,
    useMcp: true,
    includeVaultContext: true,
    reasons: ["model_decided_tool_catalog"],
  };
}

export function buildChatRouteReceipt({
  route,
  contextSignals = {},
  capabilitySignals = {},
  capabilityGraph,
}: {
  route: ChatRuntimeRoute;
  contextSignals?: ChatRoutingContextSignals;
  capabilitySignals?: ChatRoutingCapabilitySignals;
  capabilityGraph?: CapabilityGraph;
}): ChatRouteReceipt {
  const resolvedCapabilitySignals = resolveCapabilitySignals(
    capabilitySignals,
    capabilityGraph,
  );
  return {
    lane: route.lane,
    routingMode: route.routingMode ?? "regex",
    runtimeTarget: route.runtimeTarget,
    useWorker: route.useWorker,
    useMcp: route.useMcp,
    includeVaultContext: route.includeVaultContext,
    reasons: [...route.reasons],
    explanation: explainChatRuntimeRoute(route),
    contextAvailability: {
      priorUserMessages: contextSignals.priorUserMessagesCount ?? 0,
      vaultMemoryAvailable: contextSignals.vaultMemoryAvailable === true,
      artifactContextAvailable: contextSignals.artifactContextAvailable === true,
      uploadedFilesAvailable: contextSignals.uploadedFilesAvailable === true,
    },
    toolAvailability: {
      connectedProviders: resolvedCapabilitySignals.connectedProviders,
      approvedProviders: resolvedCapabilitySignals.approvedProviders,
      pendingApprovalProviders: uniqueStrings(
        resolvedCapabilitySignals.pendingApprovalProviders,
      ),
    },
    capabilityAvailability: resolvedCapabilitySignals.capabilityAvailability,
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

function hasDurableProceedIntent(
  value: string,
  priorUserMessages: readonly string[],
): string | null {
  if (!priorUserMessages.some((prior) => hasDurableIntent(normalize(prior)))) {
    return null;
  }
  if (
    /^(ok|okay|yes|yep|yeah|cool|sounds good|go ahead|do it|do those|start|ship it|proceed|please do|let'?s do it|build it|implement it)\b/.test(
      value,
    )
  ) {
    return "sticky_durable_thread";
  }
  return null;
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

function hasNumberedGithubReference(value: string): boolean {
  return /\b(issue|pull request|pr)\s*#?\d+\b/.test(value);
}

export function explainChatRuntimeRoute(route: ChatRuntimeRoute): string {
  if (route.lane === "durable-local") {
    return "Queued durable local work because this request needs resilient, longer-running execution.";
  }
  if (route.lane === "tool-local" && route.routingMode !== "model-decided") {
    // Legacy persisted regex-engine routes replayed by the worker lane.
    return "Mounted local tools because this request needs live connected-system data or follows a tool-backed thread.";
  }
  if (route.lane === "fast-local") {
    // Legacy persisted regex-engine routes replayed by the worker lane.
    return "Used fast local chat because no live tools or durable worker were needed.";
  }
  return "Mounted the authorized tool catalog and let Sonnet 4.6 decide whether this request needs a tool.";
}

interface ResolvedRoutingCapabilitySignals {
  connectedProviders: string[];
  approvedProviders: string[];
  pendingApprovalProviders: string[];
  capabilityAvailability: ChatRoutingCapabilityAvailability;
  recommendedEscalation?: ChatRoutingCapabilitySignals["recommendedEscalation"];
}

function resolveCapabilitySignals(
  signals: ChatRoutingCapabilitySignals,
  graph?: CapabilityGraph,
): ResolvedRoutingCapabilitySignals {
  const graphProviders = graph?.providers ?? [];
  const connectedFromGraph = graphProviders
    .map(providerIdFromCapability)
    .filter(isPresent);
  const approvedFromGraph = graphProviders
    .filter((entry) => entry.runnableNow)
    .map(providerIdFromCapability)
    .filter(isPresent);
  const pendingFromGraph = graphProviders
    .filter((entry) => entry.needsApproval)
    .flatMap((entry) => {
      if (entry.pendingApprovalProviders.length > 0) {
        return entry.pendingApprovalProviders.map(normalizeProviderId);
      }
      const provider = providerIdFromCapability(entry);
      return provider ? [provider] : [];
    });

  const connectedProviders = uniqueProviderIds([
    ...connectedFromGraph,
    ...(signals.connectedProviders ?? []),
  ]);
  const approvedProviders = uniqueProviderIds([
    ...approvedFromGraph,
    ...(signals.approvedProviders ?? []),
  ]);
  const pendingApprovalProviders = uniqueProviderIds([
    ...pendingFromGraph,
    ...(signals.pendingApprovalProviders ?? []),
  ]);

  return {
    connectedProviders,
    approvedProviders,
    pendingApprovalProviders,
    capabilityAvailability:
      signals.capabilityAvailability ??
      buildCapabilityAvailability(graph, {
        connectedProviders,
        approvedProviders,
        pendingApprovalProviders,
      }),
    recommendedEscalation: signals.recommendedEscalation,
  };
}

function buildCapabilityAvailability(
  graph: CapabilityGraph | undefined,
  fallback: Pick<
    ResolvedRoutingCapabilitySignals,
    "connectedProviders" | "approvedProviders" | "pendingApprovalProviders"
  >,
): ChatRoutingCapabilityAvailability {
  if (!graph) {
    return {
      providers: uniqueProviderIds([
        ...fallback.connectedProviders,
        ...fallback.approvedProviders,
        ...fallback.pendingApprovalProviders,
      ]).length,
      skills: 0,
      apps: 0,
      schedules: 0,
      runnableNow: fallback.approvedProviders.length,
      needsApproval: fallback.pendingApprovalProviders.length,
    };
  }
  const entries = [
    ...graph.providers,
    ...graph.skills,
    ...graph.apps,
    ...graph.schedules,
  ];
  return {
    providers: graph.providers.length,
    skills: graph.skills.length,
    apps: graph.apps.length,
    schedules: graph.schedules.length,
    runnableNow: entries.filter((entry) => entry.runnableNow).length,
    needsApproval: entries.filter((entry) => entry.needsApproval).length,
  };
}

function providerIdFromCapability(entry: CapabilityEntry): string | null {
  const metadataProvider = entry.metadata?.provider;
  if (typeof metadataProvider === "string" && metadataProvider.trim()) {
    return normalizeProviderId(metadataProvider);
  }
  if (entry.id.startsWith("provider:")) {
    return normalizeProviderId(entry.id.slice("provider:".length));
  }
  return normalizeProviderId(entry.name);
}


function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueProviderIds(values: readonly string[]): string[] {
  return uniqueStrings(values.map(normalizeProviderId));
}

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
