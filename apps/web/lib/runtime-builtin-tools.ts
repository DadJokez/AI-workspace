import {
  WEB_FETCH_TOOL_NAME,
  type BuiltinToolName,
} from "@ai-workspace/agent/web-fetch-tool";
import {
  WEB_SEARCH_TOOL_NAME,
  isWebSearchConfigured,
} from "@ai-workspace/agent/web-search-tool";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";

export function builtinToolsForChatRoute(
  route: ChatRuntimeRoute,
): BuiltinToolName[] {
  if (
    route.routingMode === "model-decided" ||
    route.reasons.some((reason) => reason.startsWith("web_"))
  ) {
    // Search is hidden (not erroring) until Rob provisions the provider key
    // (#313): the tool never mounts and the preamble never lists it, so
    // capability questions stay honest in both states.
    return isWebSearchConfigured()
      ? [WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME]
      : [WEB_FETCH_TOOL_NAME];
  }
  return [];
}
