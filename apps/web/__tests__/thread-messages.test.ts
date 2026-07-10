import { describe, expect, it } from "vitest";
import {
  activeRunMessageContent,
  chatRunSourceMessageId,
  latestVisibleChatRunIds,
} from "@/lib/thread-messages";

describe("activeRunMessageContent", () => {
  it("#244 hides interrupted artifact snippets behind a clear retry message", () => {
    const content = activeRunMessageContent({
      status: "canceled",
      output: {
        assistantText: [
          "Here is the update:",
          "",
          '```html filename="theme-picker.html"',
          "<!doctype html>",
          "<html>",
          "<head><title>Theme Picker</title></head>",
          "<body>",
        ].join("\n"),
      },
      hasArtifactContext: true,
    });

    expect(content).toContain("Run canceled before an answer was saved.");
    expect(content).toContain("Artifact update was interrupted");
    expect(content).toContain("Retry the run");
    expect(content).not.toContain("<!doctype html>");
  });

  it("keeps ordinary failed text visible when it is not artifact-like", () => {
    const content = activeRunMessageContent({
      status: "failed",
      error: "Provider unavailable.",
      output: {
        assistantText: "I got partway through the summary before the provider failed.",
      },
    });

    expect(content).toBe(
      "I got partway through the summary before the provider failed.",
    );
  });

  it("keeps failed explanatory snippets visible when no artifact was targeted", () => {
    const content = activeRunMessageContent({
      status: "failed",
      error: "Provider unavailable.",
      output: {
        assistantText: [
          "This HTML snippet demonstrates the issue:",
          "",
          "```html",
          "<button>Save</button>",
          "```",
        ].join("\n"),
      },
    });

    expect(content).toContain("This HTML snippet demonstrates the issue:");
    expect(content).toContain("<button>Save</button>");
    expect(content).not.toContain("Artifact update was interrupted");
  });

  it("uses generic interrupted artifact copy for explicit new files", () => {
    const content = activeRunMessageContent({
      status: "failed",
      output: {
        assistantText: [
          "Here is the file:",
          "",
          '```markdown filename="weekly-brief.md"',
          "# Weekly Brief",
        ].join("\n"),
      },
    });

    expect(content).toContain("Artifact response was interrupted");
    expect(content).not.toContain("Artifact update was interrupted");
    expect(content).not.toContain("# Weekly Brief");
  });
});

describe("chatRunSourceMessageId", () => {
  it("finds the persisted source message used to suppress abandoned branches", () => {
    expect(chatRunSourceMessageId({ userMessageId: "message-1" })).toBe(
      "message-1",
    );
    expect(chatRunSourceMessageId({})).toBeNull();
    expect(chatRunSourceMessageId(null)).toBeNull();
  });

  it("keeps only the latest run for messages on the visible branch", () => {
    const runIds = latestVisibleChatRunIds(
      [
        {
          id: "old-run",
          skillSlug: "chat-turn",
          inputs: { userMessageId: "message-1" },
        },
        {
          id: "abandoned-run",
          skillSlug: "chat-turn",
          inputs: { userMessageId: "message-removed" },
        },
        {
          id: "new-run",
          skillSlug: "chat-turn",
          inputs: { userMessageId: "message-1" },
        },
      ],
      new Set(["message-1"]),
    );

    expect([...runIds]).toEqual(["new-run"]);
  });
});
