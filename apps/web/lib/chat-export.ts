import type { AgentActivityEvent } from "@/lib/activity-events";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

export interface ChatExportMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  modelId?: string;
  status?: string;
  artifacts?: WorkspaceArtifactSummary[];
  activityEvents?: AgentActivityEvent[];
  runId?: string;
  runStatus?: string;
  runError?: string | null;
}

export interface ChatExportInput {
  title: string;
  threadId?: string;
  messages: ChatExportMessage[];
  exportedAt?: Date;
}

export function buildChatTranscriptMarkdown({
  title,
  threadId,
  messages,
  exportedAt = new Date(),
}: ChatExportInput): string {
  const lines: string[] = [
    `# ${safeHeading(title || "Chat transcript")}`,
    "",
    `- Exported: ${exportedAt.toISOString()}`,
    ...(threadId ? [`- Thread ID: ${threadId}`] : []),
    `- Messages: ${messages.length}`,
    "",
  ];

  messages.forEach((message, index) => {
    lines.push("---", "");
    lines.push(`## ${messageHeading(message, index + 1)}`, "");
    if (message.status) {
      lines.push(`Status: ${message.status}`, "");
    }
    if (message.runId || message.runStatus || message.runError) {
      lines.push("### Run");
      if (message.runId) lines.push(`- ID: ${message.runId}`);
      if (message.runStatus) lines.push(`- Status: ${message.runStatus}`);
      if (message.runError) lines.push(`- Error: ${message.runError}`);
      lines.push("");
    }
    lines.push(message.content.trim() || "(empty message)", "");

    if (message.artifacts && message.artifacts.length > 0) {
      lines.push("### Artifacts");
      for (const artifact of message.artifacts) {
        lines.push(
          `- ${artifact.filename} (${artifact.kind}, ${formatBytes(
            artifact.sizeBytes,
          )}) - ${artifact.previewUrl}`,
        );
      }
      lines.push("");
    }

    if (message.activityEvents && message.activityEvents.length > 0) {
      lines.push("### Activity");
      for (const event of message.activityEvents) {
        lines.push(`- [${event.state}] ${event.label}`);
        if (event.detail) lines.push(`  - Detail: ${event.detail}`);
      }
      lines.push("");
    }
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

export function chatTranscriptFilename({
  title,
  exportedAt = new Date(),
}: {
  title: string;
  exportedAt?: Date;
}): string {
  const date = exportedAt.toISOString().slice(0, 10);
  const slug = slugify(title || "chat");
  return `${date}-${slug}.md`;
}

function messageHeading(message: ChatExportMessage, index: number): string {
  const role = message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return message.modelId ? `${index}. ${role} - ${message.modelId}` : `${index}. ${role}`;
}

function safeHeading(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim() || "Chat transcript";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "chat";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
