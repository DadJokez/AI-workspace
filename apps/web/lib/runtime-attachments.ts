import type { AgentMessage, AgentMessageAttachment } from "@ai-workspace/agent";
import type { ChatContextUploadedFile } from "@/lib/chat-context-pack";

export function attachUploadedFilesToLatestUserMessage(
  messages: readonly AgentMessage[],
  uploadedFiles: readonly ChatContextUploadedFile[],
): AgentMessage[] {
  const imageAttachments = uploadedFiles
    .map((file): AgentMessageAttachment | null => {
      const content = file.runtimeContent;
      if (!content || content.type !== "image") return null;
      return {
        type: "image",
        name: file.name,
        mimeType: content.mimeType,
        dataBase64: content.dataBase64,
      };
    })
    .filter((item): item is AgentMessageAttachment => item !== null);

  if (imageAttachments.length === 0) return [...messages];

  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message?.role !== "user") continue;
    next[index] = {
      ...message,
      attachments: [...(message.attachments ?? []), ...imageAttachments],
    };
    return next;
  }
  return next;
}
