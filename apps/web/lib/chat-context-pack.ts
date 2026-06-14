import type { AgentMessage } from "@ai-workspace/agent";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import type { UserMcpProviderStatus } from "@/lib/oauth/mcp-servers";

export interface ChatContextUser {
  displayName: string;
  assistantName?: string | null;
  customInstructions: string | null;
}

export interface ChatContextUploadedFile {
  name: string;
  sizeBytes?: number;
}

export interface ChatContextReceipt {
  version: 1;
  generatedAt: string;
  vault: {
    checked: boolean;
    injected: boolean;
    approvedMemoryChars: number;
  };
  tools: {
    connected: string[];
    approved: string[];
    mounted: string[];
    pendingApproval: string[];
  };
  work: {
    recentMessages: number;
    threadSummaryInjected: boolean;
    artifactContextInjected: boolean;
    artifactContextChars: number;
    uploadedFilesInjected: boolean;
    uploadedFiles: ChatContextUploadedFile[];
  };
  route?: {
    lane: ChatRuntimeRoute["lane"];
    runtimeTarget: ChatRuntimeRoute["runtimeTarget"];
    useMcp: boolean;
    includeVaultContext: boolean;
    reasons: string[];
  };
}

export interface ChatContextPack {
  prompt: {
    systemPrompt?: string;
    messages: AgentMessage[];
  };
  user: ChatContextUser;
  tools: ChatContextReceipt["tools"];
  work: ChatContextReceipt["work"];
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
  modelId?: string;
  artifactContext?: string | null;
  uploadedFiles?: readonly ChatContextUploadedFile[];
  route?: ChatRuntimeRoute;
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
  modelId,
  artifactContext,
  uploadedFiles = [],
  route,
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
  const receipt: ChatContextReceipt = {
    version: 1,
    generatedAt: now.toISOString(),
    vault: {
      checked: vaultContextRequested,
      injected: vault.length > 0,
      approvedMemoryChars: vault.length,
    },
    tools: {
      connected: uniqueStrings(providerStatus.connectedProviders),
      approved: uniqueStrings(providerStatus.allowedProviders),
      mounted: uniqueStrings(mountedProviders),
      pendingApproval: blockedProviders,
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
      })),
    },
    ...(route
      ? {
          route: {
            lane: route.lane,
            runtimeTarget: route.runtimeTarget,
            useMcp: route.useMcp,
            includeVaultContext: route.includeVaultContext,
            reasons: [...route.reasons],
          },
        }
      : {}),
  };

  const shouldRenderPreamble =
    forcePreamble ||
    Boolean(route?.useMcp) ||
    Boolean(route?.includeVaultContext) ||
    Boolean(user.customInstructions?.trim()) ||
    artifacts.length > 0 ||
    hasConnectedToolState;

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
          modelId,
          artifactContext: artifacts || null,
          vaultContextRequested,
        }),
        "",
        renderContextReceiptForPrompt(receipt),
      ].join("\n")
    : undefined;

  return {
    prompt: {
      systemPrompt,
      messages,
    },
    user,
    tools: receipt.tools,
    work: receipt.work,
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
    )}; mounted this turn ${formatList(receipt.tools.mounted)}; pending approval ${formatList(
      receipt.tools.pendingApproval,
    )}.`,
  );
  lines.push(
    `- Work context: ${receipt.work.recentMessages} recent message(s); ` +
      `summary ${receipt.work.threadSummaryInjected ? "included" : "not included"}; ` +
      `artifacts ${receipt.work.artifactContextInjected ? "included" : "not included"}; ` +
      `uploaded files ${formatList(receipt.work.uploadedFiles.map((file) => file.name))}.`,
  );
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
