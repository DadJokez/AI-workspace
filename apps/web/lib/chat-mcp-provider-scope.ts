import type { ChatRoutingMode } from "@/lib/chat-routing";

export interface ChatMcpProviderScope {
  /**
   * Account status grounds the model's honesty about connected tools. It must
   * stay unfiltered even when a skill narrows which MCP servers mount.
   */
  accountStatusOptions: undefined;
  /** MCP mounting may be scoped to the skill's declared providers. */
  mountOptions?: { onlyProviders: string[] };
}

export function resolveChatMcpProviderScope(
  requestedProviders: string[] | undefined,
  routingMode: ChatRoutingMode = "regex",
): ChatMcpProviderScope {
  return {
    accountStatusOptions: undefined,
    mountOptions:
      routingMode !== "model-decided" && Array.isArray(requestedProviders)
      ? { onlyProviders: requestedProviders }
      : undefined,
  };
}
