import type { AgentMessage } from "@ai-workspace/agent";
import type { ChatMessage } from "@ai-workspace/db";

export const DEFAULT_RECENT_MESSAGE_LIMIT = 12;
export const DEFAULT_CONTEXT_CHAR_LIMIT = 120_000;
export const DEFAULT_MESSAGE_CHAR_LIMIT = 24_000;

interface BuildTurnContextInput {
  messages: Pick<ChatMessage, "role" | "content">[];
  threadSummary?: string | null;
  recentMessageLimit?: number;
  maxContextChars?: number;
  maxMessageChars?: number;
  onGuardrailEvent?: (event: TurnContextGuardrailEvent) => void;
}

export interface TurnContextGuardrailEvent {
  type:
    | "message_truncated"
    | "summary_truncated"
    | "history_dropped"
    | "context_budget_exceeded";
  originalChars?: number;
  retainedChars?: number;
  droppedMessages?: number;
  maxContextChars: number;
  maxMessageChars: number;
  recentMessageLimit: number;
}

/**
 * Build the bounded context pack sent to the runtime for a chat turn.
 *
 * The caller should pass messages after the current user message has been
 * persisted. The final message is always preserved exactly, even when the
 * recent-message or prompt-size limits are small.
 */
export function buildTurnContext({
  messages,
  threadSummary,
  recentMessageLimit = DEFAULT_RECENT_MESSAGE_LIMIT,
  maxContextChars = DEFAULT_CONTEXT_CHAR_LIMIT,
  maxMessageChars = DEFAULT_MESSAGE_CHAR_LIMIT,
  onGuardrailEvent,
}: BuildTurnContextInput): AgentMessage[] {
  if (messages.length === 0) return [];

  const current = messages[messages.length - 1]!;
  const history = messages.slice(0, -1);
  const limit = Math.max(0, Math.floor(recentMessageLimit));
  const contextBudget = Math.max(0, Math.floor(maxContextChars));
  const messageBudget = Math.max(0, Math.floor(maxMessageChars));
  const recent = limit > 0 ? history.slice(-limit) : [];

  const currentMessage: AgentMessage = {
    role: current.role,
    content: current.content,
  };
  const currentChars = messageChars(currentMessage);
  if (contextBudget > 0 && currentChars > contextBudget) {
    onGuardrailEvent?.({
      type: "context_budget_exceeded",
      originalChars: currentChars,
      retainedChars: currentChars,
      maxContextChars: contextBudget,
      maxMessageChars: messageBudget,
      recentMessageLimit: limit,
    });
  }

  const retainedHistory: AgentMessage[] = [];
  let retainedChars = currentChars;
  let droppedMessages = history.length - recent.length;

  for (let i = recent.length - 1; i >= 0; i--) {
    const source = recent[i]!;
    const message = {
      role: source.role,
      content: truncateForContext(source.content, messageBudget, {
        marker: "[Message truncated for prompt budget]",
        eventType: "message_truncated",
        onGuardrailEvent,
        maxContextChars: contextBudget,
        maxMessageChars: messageBudget,
        recentMessageLimit: limit,
      }),
    };
    const chars = messageChars(message);
    if (contextBudget > 0 && retainedChars + chars > contextBudget) {
      droppedMessages += i + 1;
      break;
    }
    retainedHistory.unshift(message);
    retainedChars += chars;
  }

  const summary = threadSummary?.trim();
  let summaryMessage: AgentMessage | null = null;
  if (summary) {
    summaryMessage = {
      role: "user",
      content: [
        "Conversation summary from earlier turns:",
        truncateForContext(summary, messageBudget, {
          marker: "[Summary truncated for prompt budget]",
          eventType: "summary_truncated",
          onGuardrailEvent,
          maxContextChars: contextBudget,
          maxMessageChars: messageBudget,
          recentMessageLimit: limit,
        }),
        "Use this as background context. Recent raw messages follow.",
      ].join("\n\n"),
    };
    const chars = messageChars(summaryMessage);
    if (contextBudget === 0 || retainedChars + chars <= contextBudget) {
      retainedChars += chars;
    } else {
      summaryMessage = null;
      onGuardrailEvent?.({
        type: "history_dropped",
        droppedMessages: 1,
        maxContextChars: contextBudget,
        maxMessageChars: messageBudget,
        recentMessageLimit: limit,
      });
    }
  }

  if (droppedMessages > 0) {
    onGuardrailEvent?.({
      type: "history_dropped",
      droppedMessages,
      maxContextChars: contextBudget,
      maxMessageChars: messageBudget,
      recentMessageLimit: limit,
    });
  }

  return [
    ...(summaryMessage ? [summaryMessage] : []),
    ...retainedHistory,
    currentMessage,
  ];
}

function messageChars(message: AgentMessage): number {
  return message.content.length;
}

function truncateForContext(
  content: string,
  maxChars: number,
  opts: {
    marker: string;
    eventType: "message_truncated" | "summary_truncated";
    onGuardrailEvent?: (event: TurnContextGuardrailEvent) => void;
    maxContextChars: number;
    maxMessageChars: number;
    recentMessageLimit: number;
  },
): string {
  if (maxChars === 0 || content.length <= maxChars) return content;

  const marker = `\n\n${opts.marker}\n\n`;
  const retainedChars = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = Math.floor(retainedChars / 2);
  const truncated =
    content.slice(0, headChars) +
    marker +
    (tailChars > 0 ? content.slice(-tailChars) : "");

  opts.onGuardrailEvent?.({
    type: opts.eventType,
    originalChars: content.length,
    retainedChars: truncated.length,
    maxContextChars: opts.maxContextChars,
    maxMessageChars: opts.maxMessageChars,
    recentMessageLimit: opts.recentMessageLimit,
  });

  return truncated;
}
