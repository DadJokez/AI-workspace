import {
  foldAttachmentsIntoPrompt,
  type PreparedChatAttachment,
} from "@/lib/attachments";
import type { ConversationResourceResolution } from "@/lib/conversation-resources";

export interface ConversationResourcePromptReceipt {
  mode: "message_only" | "resource_reference" | "inline_fallback";
  attachmentCount: number;
  resourceCount: number;
  extractedCharsAvailable: number;
  inlineAttachmentChars: number;
}

export interface ConversationResourcePromptPlan {
  prompt: string;
  receipt: ConversationResourcePromptReceipt;
}

export function buildConversationResourcePrompt({
  message,
  attachments,
  resourceIds,
  resolution,
}: {
  message: string;
  attachments: readonly PreparedChatAttachment[];
  resourceIds: readonly string[];
  resolution: ConversationResourceResolution;
}): ConversationResourcePromptPlan {
  const extractedCharsAvailable = attachments.reduce(
    (total, attachment) => total + attachment.content.length,
    0,
  );
  if (attachments.length === 0) {
    return {
      prompt: message,
      receipt: {
        mode: "message_only",
        attachmentCount: 0,
        resourceCount: 0,
        extractedCharsAvailable: 0,
        inlineAttachmentChars: 0,
      },
    };
  }

  const selectedIds = new Set(
    resolution.status === "selected"
      ? resolution.selected.map((resource) => resource.resourceId)
      : [],
  );
  const matchingResourceCount = resourceIds.filter((resourceId) =>
    selectedIds.has(resourceId),
  ).length;
  const fullyResourceBacked =
    resourceIds.length === attachments.length &&
    matchingResourceCount === attachments.length;
  if (fullyResourceBacked) {
    return {
      prompt: message,
      receipt: {
        mode: "resource_reference",
        attachmentCount: attachments.length,
        resourceCount: resourceIds.length,
        extractedCharsAvailable,
        inlineAttachmentChars: 0,
      },
    };
  }

  const prompt = foldAttachmentsIntoPrompt(message, attachments);
  return {
    prompt,
      receipt: {
        mode: "inline_fallback",
        attachmentCount: attachments.length,
        resourceCount: matchingResourceCount,
        extractedCharsAvailable,
        inlineAttachmentChars: Math.max(0, prompt.length - message.length),
      },
  };
}
