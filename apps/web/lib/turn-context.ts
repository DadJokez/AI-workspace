import type { AgentMessage } from "@ai-workspace/agent";
import type { ChatMessage } from "@ai-workspace/db";

export const DEFAULT_RECENT_MESSAGE_LIMIT = 12;

interface BuildTurnContextInput {
  messages: Pick<ChatMessage, "role" | "content">[];
  threadSummary?: string | null;
  recentMessageLimit?: number;
}

/**
 * Build the bounded context pack sent to the runtime for a chat turn.
 *
 * The caller should pass messages after the current user message has been
 * persisted. The final message is always preserved exactly, even when the
 * recent-message limit is small.
 */
export function buildTurnContext({
  messages,
  threadSummary,
  recentMessageLimit = DEFAULT_RECENT_MESSAGE_LIMIT,
}: BuildTurnContextInput): AgentMessage[] {
  if (messages.length === 0) return [];

  const current = messages[messages.length - 1]!;
  const history = messages.slice(0, -1);
  const limit = Math.max(0, Math.floor(recentMessageLimit));
  const recent = limit > 0 ? history.slice(-limit) : [];

  const context: AgentMessage[] = [];
  const summary = threadSummary?.trim();
  if (summary) {
    context.push({
      role: "user",
      content: [
        "Conversation summary from earlier turns:",
        summary,
        "Use this as background context. Recent raw messages follow.",
      ].join("\n\n"),
    });
  }

  context.push(
    ...recent.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  );

  context.push({
    role: current.role,
    content: current.content,
  });

  return context;
}
