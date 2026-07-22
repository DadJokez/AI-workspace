import type { FeedbackContext } from "@/components/FeedbackReporter";
import {
  buildChatTranscriptMarkdown,
  chatTranscriptFilename,
} from "@/lib/chat-export";
import type { ChatTab } from "./chat-client-state";

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadChatTranscript(tab: ChatTab) {
  if (tab.messages.length === 0) return;
  const exportedAt = new Date();
  downloadTextFile(
    chatTranscriptFilename({ title: tab.title, exportedAt }),
    buildChatTranscriptMarkdown({
      title: tab.title,
      threadId: tab.threadId,
      messages: tab.messages,
      exportedAt,
    }),
  );
}

export function buildFeedbackContext(tab: ChatTab): FeedbackContext {
  const lastAssistantMessage = [...tab.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const lastArtifact = [...tab.messages]
    .reverse()
    .flatMap((message) => message.artifacts ?? [])
    .find(Boolean);

  return {
    threadId: tab.threadId,
    threadTitle: tab.title,
    messageId:
      lastAssistantMessage?.id && !lastAssistantMessage.id.startsWith("run:")
        ? lastAssistantMessage.id
        : undefined,
    messagePreview: lastAssistantMessage?.content
      ? lastAssistantMessage.content.slice(0, 600)
      : undefined,
    runId: lastAssistantMessage?.runId,
    artifactId: lastArtifact?.id,
    artifactTitle: lastArtifact?.title ?? lastArtifact?.filename,
  };
}
