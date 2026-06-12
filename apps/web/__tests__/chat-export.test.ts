import { describe, expect, it } from "vitest";
import {
  buildChatTranscriptMarkdown,
  chatTranscriptFilename,
} from "@/lib/chat-export";

describe("buildChatTranscriptMarkdown", () => {
  it("exports messages, artifacts, run state, and activity as markdown", () => {
    const transcript = buildChatTranscriptMarkdown({
      title: "Markdown file issue",
      threadId: "thread_123",
      exportedAt: new Date("2026-06-06T12:00:00.000Z"),
      messages: [
        {
          role: "user",
          content: "make me a md file",
        },
        {
          role: "assistant",
          modelId: "claude-sonnet-4-6",
          content: "Written to `markdown-formatting-reference.md`.",
          runId: "run_123",
          runStatus: "succeeded",
          artifacts: [
            {
              id: "artifact_1",
              title: "Markdown Formatting Reference",
              filename: "markdown-formatting-reference.md",
              kind: "markdown",
              mimeType: "text/markdown",
              sizeBytes: 2048,
              source: "assistant-code-block",
              threadId: "thread_123",
              chatMessageId: "message_123",
              runId: "run_123",
              createdAt: "2026-06-06T12:00:00.000Z",
              previewUrl: "/workspace/artifacts/artifact_1",
              downloadUrl: "/api/workspace/artifacts/artifact_1/download",
            },
          ],
          activityEvents: [
            {
              id: "event_1",
              state: "succeeded",
              label: "Stored assistant answer",
            },
          ],
        },
        {
          role: "assistant",
          content: "",
          runStatus: "failed",
          runError: "Artifact extraction failed",
        },
      ],
    });

    expect(transcript).toContain("# Markdown file issue");
    expect(transcript).toContain("- Thread ID: thread_123");
    expect(transcript).toContain("## 1. User");
    expect(transcript).toContain("## 2. Assistant - claude-sonnet-4-6");
    expect(transcript).toContain("Written to `markdown-formatting-reference.md`.");
    expect(transcript).toContain("### Artifacts");
    expect(transcript).toContain(
      "markdown-formatting-reference.md (markdown, 2.0 KB)",
    );
    expect(transcript).toContain("### Activity");
    expect(transcript).toContain("[succeeded] Stored assistant answer");
    expect(transcript).toContain("- Error: Artifact extraction failed");
  });
});

describe("chatTranscriptFilename", () => {
  it("creates a dated markdown filename from the chat title", () => {
    expect(
      chatTranscriptFilename({
        title: "Make me a MD file!",
        exportedAt: new Date("2026-06-06T12:00:00.000Z"),
      }),
    ).toBe("2026-06-06-make-me-a-md-file.md");
  });
});
