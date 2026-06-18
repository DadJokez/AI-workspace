import type { AgentMessage } from "@ai-workspace/agent";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import {
  renderCapabilitySummaryForPrompt,
  type CapabilityGraph,
} from "@/lib/capability-graph";
import {
  explainChatRuntimeRoute,
  type ChatRuntimeRoute,
} from "@/lib/chat-routing";
import type { UserMcpProviderStatus } from "@/lib/oauth/mcp-servers";
import type {
  RecommendationCandidate,
  RecommendationType,
} from "@/lib/recommendations";

export interface ChatContextUser {
  displayName: string;
  assistantName?: string | null;
  customInstructions: string | null;
}

export interface ChatContextUploadedFile {
  name: string;
  sizeBytes?: number;
  mimeType?: string;
  extractionStatus?: string;
  runtimeContent?: {
    type: "image";
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    dataBase64: string;
  };
}

export type ChatContextItemOwner = "user" | "assistant" | "workspace" | "system";

export type ChatContextItemFreshness =
  | "current_turn"
  | "recent_thread"
  | "durable"
  | "live_account"
  | "unknown";

export type ChatContextItemVisibility = "hidden_prompt" | "receipt_only";

export interface ChatContextItem {
  id: string;
  type:
    | "profile_fact"
    | "custom_instruction"
    | "vault_memory"
    | "recent_message"
    | "thread_summary"
    | "artifact_context"
    | "uploaded_file"
    | "capability_graph";
  label: string;
  source: string;
  owner: ChatContextItemOwner;
  freshness: ChatContextItemFreshness;
  visibility: ChatContextItemVisibility;
  injected: boolean;
  charCount?: number;
  metadata?: Record<string, unknown>;
}

export interface ChatContextProviderItem {
  provider: string;
  source: "oauth_tokens" | "tool_attestations" | "mcp_mount";
  owner: "user";
  freshness: "live_account";
  visibility: ChatContextItemVisibility;
  connected: boolean;
  approved: boolean;
  mounted: boolean;
  pendingApproval: boolean;
  injected: boolean;
}

export interface ChatContextRecommendationPack {
  tools: RecommendationCandidate[];
  skills: RecommendationCandidate[];
  apps: RecommendationCandidate[];
  schedules: RecommendationCandidate[];
}

export interface ChatContextReceipt {
  version: 1;
  schema: "context-pack.v2";
  generatedAt: string;
  vault: {
    checked: boolean;
    injected: boolean;
    approvedMemoryChars: number;
    approvedMemoryItems: number;
  };
  tools: {
    connected: string[];
    approved: string[];
    mounted: string[];
    builtinMounted: string[];
    pendingApproval: string[];
    providers: ChatContextProviderItem[];
  };
  work: {
    recentMessages: number;
    threadSummaryInjected: boolean;
    artifactContextInjected: boolean;
    artifactContextChars: number;
    uploadedFilesInjected: boolean;
    uploadedFiles: ChatContextUploadedFile[];
  };
  capabilities: {
    providers: number;
    skills: number;
    apps: number;
    schedules: number;
    runnableNow: number;
    needsApproval: number;
    connectedNotMountedProviders: string[];
  };
  contextItems: ChatContextItem[];
  recommendations: Record<RecommendationType, number>;
  route?: {
    lane: ChatRuntimeRoute["lane"];
    runtimeTarget: ChatRuntimeRoute["runtimeTarget"];
    useWorker: boolean;
    useMcp: boolean;
    includeVaultContext: boolean;
    reasons: string[];
    explanation: string;
  };
}

export interface ChatContextPack {
  prompt: {
    systemPrompt?: string;
    messages: AgentMessage[];
  };
  user: ChatContextUser & {
    profileFacts: ChatContextItem[];
    vaultMemory: ChatContextItem[];
    customInstructionsItem?: ChatContextItem;
  };
  tools: {
    connected: ChatContextProviderItem[];
    approved: ChatContextProviderItem[];
    mounted: ChatContextProviderItem[];
    pendingApproval: ChatContextProviderItem[];
  };
  work: {
    threadSummary?: ChatContextItem;
    recentMessages: ChatContextItem[];
    artifacts: ChatContextItem[];
    uploadedFiles: ChatContextItem[];
  };
  recommendations: ChatContextRecommendationPack;
  receipts: ChatContextReceipt[];
}

export interface BuildChatContextPackInput {
  user: ChatContextUser;
  messages: AgentMessage[];
  threadSummary?: string | null;
  vaultMarkdown?: string | null;
  vaultContextRequested: boolean;
  providerStatus: UserMcpProviderStatus;
  mountedProviders: readonly string[];
  deniedMcpProviders?: readonly string[];
  capabilityGraph?: CapabilityGraph;
  modelId?: string;
  artifactContext?: string | null;
  uploadedFiles?: readonly ChatContextUploadedFile[];
  recommendations?: readonly RecommendationCandidate[];
  route?: ChatRuntimeRoute;
  builtinTools?: readonly string[];
  forcePreamble?: boolean;
  now?: Date;
}

export function buildChatContextPack({
  user,
  messages,
  threadSummary,
  vaultMarkdown,
  vaultContextRequested,
  providerStatus,
  mountedProviders,
  deniedMcpProviders = [],
  capabilityGraph,
  modelId,
  artifactContext,
  uploadedFiles = [],
  recommendations = [],
  route,
  builtinTools = [],
  forcePreamble = false,
  now = new Date(),
}: BuildChatContextPackInput): ChatContextPack {
  const blockedProviders = uniqueStrings([
    ...providerStatus.deniedProviders,
    ...deniedMcpProviders,
  ]);
  const vault = vaultMarkdown?.trim() ?? "";
  const artifacts = artifactContext?.trim() ?? "";
  const hasConnectedToolState =
    providerStatus.connectedProviders.length > 0 || blockedProviders.length > 0;
  const hasCapabilityState = capabilityGraphHasEntries(capabilityGraph);
  const shouldRenderPreamble =
    forcePreamble ||
    Boolean(route?.useMcp) ||
    builtinTools.length > 0 ||
    Boolean(route?.includeVaultContext) ||
    Boolean(user.customInstructions?.trim()) ||
    artifacts.length > 0 ||
    hasCapabilityState ||
    hasConnectedToolState;
  const visibility: ChatContextItemVisibility = shouldRenderPreamble
    ? "hidden_prompt"
    : "receipt_only";
  const profileFacts = buildProfileFacts(user, shouldRenderPreamble);
  const customInstructions = user.customInstructions?.trim()
    ? contextItem({
        id: "user:custom-instructions",
        type: "custom_instruction",
        label: "User custom instructions",
        source: "users.custom_instructions",
        owner: "user",
        freshness: "durable",
        visibility,
        injected: shouldRenderPreamble,
        charCount: user.customInstructions.trim().length,
      })
    : undefined;
  const vaultMemory = buildVaultMemoryItems({
    vault,
    checked: vaultContextRequested,
    injected: shouldRenderPreamble && vault.length > 0,
  });
  const threadSummaryItem = threadSummary?.trim()
    ? contextItem({
        id: "thread:summary",
        type: "thread_summary",
        label: "Thread summary",
        source: "chat_threads.summary",
        owner: "workspace",
        freshness: "recent_thread",
        visibility: "hidden_prompt",
        injected: true,
        charCount: threadSummary.trim().length,
      })
    : undefined;
  const recentMessageItems = messages.map((message, index) =>
    contextItem({
      id: `thread:message:${index + 1}`,
      type: "recent_message",
      label: `${message.role} message`,
      source: "chat_messages",
      owner: ownerFromMessageRole(message.role),
      freshness: index === messages.length - 1 ? "current_turn" : "recent_thread",
      visibility: "hidden_prompt",
      injected: true,
      charCount: textLength(message.content),
      metadata: { role: message.role, ordinal: index + 1 },
    }),
  );
  const artifactItems =
    artifacts.length > 0
      ? [
          contextItem({
            id: "workspace:artifacts",
            type: "artifact_context",
            label: "Workspace artifact context",
            source: "workspace_artifacts",
            owner: "workspace",
            freshness: "durable",
            visibility: shouldRenderPreamble ? "hidden_prompt" : "receipt_only",
            injected: shouldRenderPreamble,
            charCount: artifacts.length,
          }),
        ]
      : [];
  const uploadedFileItems = uploadedFiles.map((file, index) =>
    contextItem({
      id: `uploaded-file:${index + 1}:${file.name}`,
      type: "uploaded_file",
      label: file.name,
      source: "uploaded_files",
      owner: "user",
      freshness: "current_turn",
      visibility: "hidden_prompt",
      injected: true,
      charCount: file.sizeBytes,
      metadata: {
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.extractionStatus ? { extractionStatus: file.extractionStatus } : {}),
      },
    }),
  );
  const providerItems = buildProviderItems({
    connectedProviders: providerStatus.connectedProviders,
    approvedProviders: providerStatus.allowedProviders,
    mountedProviders,
    pendingApprovalProviders: blockedProviders,
    injected: shouldRenderPreamble,
  });
  const capabilityItem = capabilityGraph
    ? contextItem({
        id: "workspace:capability-graph",
        type: "capability_graph",
        label: "Capability graph",
        source: "capability_graph",
        owner: "workspace",
        freshness: "live_account",
        visibility: shouldRenderPreamble ? "hidden_prompt" : "receipt_only",
        injected: shouldRenderPreamble,
        metadata: buildCapabilityReceipt(capabilityGraph),
      })
    : undefined;
  const recommendationPack = bucketRecommendations(recommendations);
  const contextItems = [
    ...profileFacts,
    ...(customInstructions ? [customInstructions] : []),
    ...vaultMemory,
    ...(threadSummaryItem ? [threadSummaryItem] : []),
    ...recentMessageItems,
    ...artifactItems,
    ...uploadedFileItems,
    ...(capabilityItem ? [capabilityItem] : []),
  ];
  const capabilityReceipt = buildCapabilityReceipt(capabilityGraph);
  const receipt: ChatContextReceipt = {
    version: 1,
    schema: "context-pack.v2",
    generatedAt: now.toISOString(),
    vault: {
      checked: vaultContextRequested,
      injected: shouldRenderPreamble && vault.length > 0,
      approvedMemoryChars: vault.length,
      approvedMemoryItems: countVaultMemoryItems(vault),
    },
    tools: {
      connected: uniqueStrings(providerStatus.connectedProviders),
      approved: uniqueStrings(providerStatus.allowedProviders),
      mounted: uniqueStrings(mountedProviders),
      builtinMounted: uniqueStrings(builtinTools),
      pendingApproval: blockedProviders,
      providers: providerItems,
    },
    work: {
      recentMessages: messages.length,
      threadSummaryInjected: Boolean(threadSummary?.trim()),
      artifactContextInjected: artifacts.length > 0,
      artifactContextChars: artifacts.length,
      uploadedFilesInjected: uploadedFiles.length > 0,
      uploadedFiles: uploadedFiles.map((file) => ({
        name: file.name,
        ...(typeof file.sizeBytes === "number" ? { sizeBytes: file.sizeBytes } : {}),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.extractionStatus ? { extractionStatus: file.extractionStatus } : {}),
      })),
    },
    capabilities: capabilityReceipt,
    contextItems: contextItems.map(compactContextItem),
    recommendations: {
      tool: recommendationPack.tools.length,
      save_as_skill: recommendationPack.skills.filter(
        (candidate) => candidate.type === "save_as_skill",
      ).length,
      run_existing_skill: recommendationPack.skills.filter(
        (candidate) => candidate.type === "run_existing_skill",
      ).length,
      open_existing_app: recommendationPack.apps.filter(
        (candidate) => candidate.type === "open_existing_app",
      ).length,
      deploy_artifact_as_app: recommendationPack.apps.filter(
        (candidate) => candidate.type === "deploy_artifact_as_app",
      ).length,
      schedule_skill: recommendationPack.schedules.length,
    },
    ...(route
      ? {
          route: {
            lane: route.lane,
            runtimeTarget: route.runtimeTarget,
            useWorker: route.useWorker,
            useMcp: route.useMcp,
            includeVaultContext: route.includeVaultContext,
            reasons: [...route.reasons],
            explanation: explainChatRuntimeRoute(route),
          },
        }
      : {}),
  };

  const systemPrompt = shouldRenderPreamble
    ? [
        buildAgentPreamble({
          user: {
            displayName: user.displayName,
            assistantName: user.assistantName,
            customInstructions: user.customInstructions,
            vaultMarkdown: vault || null,
          },
          connectedProviders: receipt.tools.mounted,
          availableProviders: receipt.tools.approved,
          blockedProviders: receipt.tools.pendingApproval,
          builtinTools: receipt.tools.builtinMounted,
          modelId,
          artifactContext: artifacts || null,
          vaultContextRequested,
        }),
        "",
        ...(capabilityGraph && hasCapabilityState
          ? [renderCapabilitySummaryForPrompt(capabilityGraph), ""]
          : []),
        renderContextReceiptForPrompt(receipt),
      ].join("\n")
    : undefined;

  return {
    prompt: {
      systemPrompt,
      messages,
    },
    user: {
      ...user,
      profileFacts,
      vaultMemory,
      ...(customInstructions ? { customInstructionsItem: customInstructions } : {}),
    },
    tools: {
      connected: providerItems.filter((item) => item.connected),
      approved: providerItems.filter((item) => item.approved),
      mounted: providerItems.filter((item) => item.mounted),
      pendingApproval: providerItems.filter((item) => item.pendingApproval),
    },
    work: {
      ...(threadSummaryItem ? { threadSummary: threadSummaryItem } : {}),
      recentMessages: recentMessageItems,
      artifacts: artifactItems,
      uploadedFiles: uploadedFileItems,
    },
    recommendations: recommendationPack,
    receipts: [receipt],
  };
}

function renderContextReceiptForPrompt(receipt: ChatContextReceipt): string {
  const lines = ["Context receipt for this turn:"];
  lines.push(
    `- Vault: ${receipt.vault.checked ? "checked" : "not checked"}; ` +
      `${receipt.vault.injected ? "approved memory injected" : "no approved memory injected"}.`,
  );
  lines.push(
    `- Tools: connected ${formatList(receipt.tools.connected)}; approved ${formatList(
      receipt.tools.approved,
    )}; mounted this turn ${formatList(receipt.tools.mounted)}; built-in mounted ${formatList(
      receipt.tools.builtinMounted,
    )}; pending approval ${formatList(receipt.tools.pendingApproval)}.`,
  );
  lines.push(
    `- Work context: ${receipt.work.recentMessages} recent message(s); ` +
      `summary ${receipt.work.threadSummaryInjected ? "included" : "not included"}; ` +
      `artifacts ${receipt.work.artifactContextInjected ? "included" : "not included"}; ` +
      `uploaded files ${formatList(receipt.work.uploadedFiles.map((file) => file.name))}.`,
  );
  lines.push(
    `- Capabilities: ${receipt.capabilities.providers} tool provider(s), ` +
      `${receipt.capabilities.skills} skill(s), ${receipt.capabilities.apps} app(s), ` +
      `${receipt.capabilities.schedules} schedule(s); ` +
      `${receipt.capabilities.runnableNow} runnable now; ` +
      `${receipt.capabilities.needsApproval} need approval; ` +
      `connected but not mounted ${formatList(
        receipt.capabilities.connectedNotMountedProviders,
      )}.`,
  );
  if (receipt.route) {
    lines.push(
      `- Routing: ${receipt.route.explanation} Lane ${receipt.route.lane}; ` +
        `target ${receipt.route.runtimeTarget}; ` +
        `${receipt.route.useWorker ? "worker queued" : "streaming inline"}; ` +
        `${receipt.route.useMcp ? "tools mounted or available for mounting" : "no tools mounted"}; ` +
        `${receipt.route.includeVaultContext ? "Vault context requested" : "Vault context not requested"}; ` +
        `reasons ${formatList(receipt.route.reasons)}.`,
    );
  }
  lines.push(`- Context sources: ${formatContextSources(receipt.contextItems)}.`);
  lines.push(
    "If the user asks what context was available or why you knew something, answer from this receipt and the injected context above.",
  );
  return lines.join("\n");
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildProfileFacts(
  user: ChatContextUser,
  injected: boolean,
): ChatContextItem[] {
  const visibility: ChatContextItemVisibility = injected
    ? "hidden_prompt"
    : "receipt_only";
  const facts = [
    contextItem({
      id: "user:display-name",
      type: "profile_fact",
      label: `Display name: ${user.displayName}`,
      source: "users.display_name",
      owner: "user",
      freshness: "durable",
      visibility,
      injected,
      charCount: user.displayName.length,
    }),
  ];
  const assistantName = user.assistantName?.trim();
  if (assistantName) {
    facts.push(
      contextItem({
        id: "user:assistant-name",
        type: "profile_fact",
        label: `Assistant name: ${assistantName}`,
        source: "users.assistant_name",
        owner: "user",
        freshness: "durable",
        visibility,
        injected,
        charCount: assistantName.length,
      }),
    );
  }
  return facts;
}

function buildVaultMemoryItems({
  vault,
  checked,
  injected,
}: {
  vault: string;
  checked: boolean;
  injected: boolean;
}): ChatContextItem[] {
  if (vault) {
    return [
      contextItem({
        id: "vault:approved-memory",
        type: "vault_memory",
        label: "Approved Vault memory",
        source: "user_memory_items.approved",
        owner: "user",
        freshness: "durable",
        visibility: "hidden_prompt",
        injected,
        charCount: vault.length,
        metadata: { approvedMemoryItems: countVaultMemoryItems(vault) },
      }),
    ];
  }
  if (!checked) return [];
  return [
    contextItem({
      id: "vault:checked-empty",
      type: "vault_memory",
      label: "Vault checked; no approved memory available",
      source: "user_memory_items.approved",
      owner: "user",
      freshness: "durable",
      visibility: "receipt_only",
      injected: false,
      charCount: 0,
      metadata: { approvedMemoryItems: 0 },
    }),
  ];
}

function buildProviderItems({
  connectedProviders,
  approvedProviders,
  mountedProviders,
  pendingApprovalProviders,
  injected,
}: {
  connectedProviders: readonly string[];
  approvedProviders: readonly string[];
  mountedProviders: readonly string[];
  pendingApprovalProviders: readonly string[];
  injected: boolean;
}): ChatContextProviderItem[] {
  const connected = new Set(connectedProviders);
  const approved = new Set(approvedProviders);
  const mounted = new Set(mountedProviders);
  const pending = new Set(pendingApprovalProviders);
  return uniqueStrings([
    ...connectedProviders,
    ...approvedProviders,
    ...mountedProviders,
    ...pendingApprovalProviders,
  ]).map((provider) => ({
    provider,
    source: mounted.has(provider)
      ? "mcp_mount"
      : approved.has(provider) || pending.has(provider)
        ? "tool_attestations"
        : "oauth_tokens",
    owner: "user",
    freshness: "live_account",
    visibility: injected ? "hidden_prompt" : "receipt_only",
    connected: connected.has(provider),
    approved: approved.has(provider),
    mounted: mounted.has(provider),
    pendingApproval: pending.has(provider),
    injected,
  }));
}

function bucketRecommendations(
  recommendations: readonly RecommendationCandidate[],
): ChatContextRecommendationPack {
  return {
    tools: recommendations.filter((candidate) => candidate.type === "tool"),
    skills: recommendations.filter(
      (candidate) =>
        candidate.type === "save_as_skill" ||
        candidate.type === "run_existing_skill",
    ),
    apps: recommendations.filter(
      (candidate) =>
        candidate.type === "open_existing_app" ||
        candidate.type === "deploy_artifact_as_app",
    ),
    schedules: recommendations.filter(
      (candidate) => candidate.type === "schedule_skill",
    ),
  };
}

function contextItem(item: ChatContextItem): ChatContextItem {
  return item;
}

function compactContextItem(item: ChatContextItem): ChatContextItem {
  return {
    id: item.id,
    type: item.type,
    label: item.label,
    source: item.source,
    owner: item.owner,
    freshness: item.freshness,
    visibility: item.visibility,
    injected: item.injected,
    ...(typeof item.charCount === "number" ? { charCount: item.charCount } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  };
}

function ownerFromMessageRole(role: AgentMessage["role"]): ChatContextItemOwner {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "system";
}

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function countVaultMemoryItems(vault: string): number {
  if (!vault.trim()) return 0;
  return vault.split("\n").filter((line) => /^\s*-\s+/.test(line)).length || 1;
}

function formatContextSources(items: readonly ChatContextItem[]): string {
  if (items.length === 0) return "none";
  const counts = new Map<string, { total: number; injected: number }>();
  for (const item of items) {
    const current = counts.get(item.source) ?? { total: 0, injected: 0 };
    current.total += 1;
    if (item.injected) current.injected += 1;
    counts.set(item.source, current);
  }
  return [...counts.entries()]
    .map(
      ([source, count]) =>
        `${source} ${count.injected}/${count.total} injected`,
    )
    .join("; ");
}

function capabilityGraphHasEntries(
  graph: CapabilityGraph | undefined,
): graph is CapabilityGraph {
  if (!graph) return false;
  return (
    graph.providers.length +
      graph.skills.length +
      graph.apps.length +
      graph.schedules.length >
    0
  );
}

function buildCapabilityReceipt(graph: CapabilityGraph | undefined): {
  providers: number;
  skills: number;
  apps: number;
  schedules: number;
  runnableNow: number;
  needsApproval: number;
  connectedNotMountedProviders: string[];
} {
  if (!graph) {
    return {
      providers: 0,
      skills: 0,
      apps: 0,
      schedules: 0,
      runnableNow: 0,
      needsApproval: 0,
      connectedNotMountedProviders: [],
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
    connectedNotMountedProviders: graph.providers
      .filter((entry) => entry.runnableNow && entry.mountedNow === false)
      .map((entry) => entry.name),
  };
}
