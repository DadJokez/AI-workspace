import {
  WEB_FETCH_TOOL_NAME,
  type BuiltinToolName,
} from "@ai-workspace/agent/web-fetch-tool";
import {
  WEB_SEARCH_TOOL_NAME,
  isWebSearchConfigured,
} from "@ai-workspace/agent/web-search-tool";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import { WEB_FETCH_ENABLED } from "@/lib/deployment-config";

export function builtinToolsForChatRoute(
  route: ChatRuntimeRoute,
  {
    interactive = true,
    webAccessDeclared = false,
  }: {
    interactive?: boolean;
    webAccessDeclared?: boolean;
  } = {},
): BuiltinToolName[] {
  const shouldMountWeb = interactive
    ? route.routingMode === "model-decided" ||
      route.reasons.some((reason) => reason.startsWith("web_"))
    : webAccessDeclared;
  if (shouldMountWeb) {
    // Search is hidden (not erroring) until Rob provisions the provider key
    // (#313), and a deployment can remove URL fetch (WEB_FETCH_ENABLED=0). A
    // tool that is off never mounts and the preamble never lists it, so
    // capability questions stay honest in every state.
    const tools: BuiltinToolName[] = [];
    if (WEB_FETCH_ENABLED) tools.push(WEB_FETCH_TOOL_NAME);
    if (isWebSearchConfigured()) tools.push(WEB_SEARCH_TOOL_NAME);
    return tools;
  }
  return [];
}
