import { describe, expect, it } from "vitest";
import { buildThreadPresentationMetadata } from "@/lib/thread-metadata";

describe("buildThreadPresentationMetadata", () => {
  it("uses a later substantive request for the auto title", () => {
    const metadata = buildThreadPresentationMetadata({
      currentTitle: "Hey",
      titleSource: "auto",
      messages: [
        { role: "user", content: "hey" },
        { role: "assistant", content: "Hey! What can I help with?" },
        {
          role: "user",
          content: "Can you summarize the last three GitHub PRs?",
        },
        {
          role: "assistant",
          content: "I checked GitHub and summarized the latest PR activity.",
        },
      ],
    });

    expect(metadata.title).toBe("Summarize the last three GitHub PRs");
    expect(metadata.previewSummary).toContain("Latest:");
    expect(metadata.previewSummary).toContain("GitHub PRs");
  });

  it("does not overwrite a manual title", () => {
    const metadata = buildThreadPresentationMetadata({
      currentTitle: "My saved title",
      titleSource: "manual",
      messages: [
        { role: "user", content: "Build an artifact preview pane" },
        { role: "assistant", content: "Added an in-tab preview drawer." },
      ],
    });

    expect(metadata.title).toBeUndefined();
    expect(metadata.previewSummary).toContain("artifact preview pane");
  });

  it("strips code blocks out of preview summaries", () => {
    const metadata = buildThreadPresentationMetadata({
      currentTitle: "HTML",
      titleSource: "auto",
      messages: [
        { role: "user", content: "Make an HTML demo" },
        {
          role: "assistant",
          content:
            "Here it is:\n```html\n<html><body>big file</body></html>\n```\nSaved as an artifact.",
        },
      ],
    });

    expect(metadata.previewSummary).not.toContain("<html>");
    expect(metadata.previewSummary).toContain("Saved as an artifact");
  });
});
