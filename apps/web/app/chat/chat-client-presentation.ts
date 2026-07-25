import type { FeedbackContext } from "@/components/FeedbackReporter";
import {
  buildChatTranscriptMarkdown,
  chatTranscriptFilename,
} from "@/lib/chat-export";
import type { ChatTab } from "./chat-client-state";

function saveBlobFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadTextFile(filename: string, content: string) {
  saveBlobFile(
    filename,
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
}

/**
 * Extract a safe transcript filename from a Content-Disposition header.
 * Supports the `filename*` (RFC 5987) and `filename` forms; strips path
 * separators and control characters, and rejects anything that is not a
 * plain `.md` name so a hostile header can never pick the extension.
 */
export function transcriptFilenameFromContentDisposition(
  header: string | null,
): string | undefined {
  if (!header) return undefined;
  let raw: string | undefined;
  const extended = /filename\*=utf-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      raw = decodeURIComponent(extended[1]!.trim());
    } catch {
      raw = undefined;
    }
  }
  if (raw === undefined) {
    raw =
      /filename="([^"]*)"/.exec(header)?.[1] ??
      /filename=([^";\s]+)/.exec(header)?.[1];
  }
  if (raw === undefined) return undefined;
  const sanitized = raw.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim();
  if (!sanitized.endsWith(".md") || sanitized === ".md") return undefined;
  return sanitized;
}

/**
 * #653: download a persisted thread through the export API with the response
 * actually verified — bare anchor navigation either dumped raw JSON into the
 * tab or silently saved an empty file when the route failed. Throws on any
 * invalid response; the caller owns the visible error. Success only means a
 * validated download was initiated — page JS cannot observe the OS save.
 */
export async function downloadPersistedThreadTranscript(tab: ChatTab) {
  if (!tab.threadId) return;
  const res = await fetch(
    `/api/threads/${encodeURIComponent(tab.threadId)}/export`,
  );
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || res.redirected || !contentType.startsWith("text/markdown")) {
    throw new Error(`transcript_export_invalid_response:${res.status}`);
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error("transcript_export_empty_body");
  }
  saveBlobFile(
    transcriptFilenameFromContentDisposition(
      res.headers.get("content-disposition"),
    ) ?? chatTranscriptFilename({ title: tab.title }),
    blob,
  );
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
