import {
  WEB_FETCH_TOOL_NAME,
  type BuiltinToolName,
} from "@ai-workspace/agent/web-fetch-tool";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";

export function builtinToolsForChatRoute(
  route: ChatRuntimeRoute,
): BuiltinToolName[] {
  if (route.reasons.some((reason) => reason.startsWith("web_"))) {
    return [WEB_FETCH_TOOL_NAME];
  }
  return [];
}
