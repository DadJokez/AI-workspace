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
    expect(metadata.previewSummary).toContain("Asked:");
    expect(metadata.previewSummary).toContain("Answer:");
    expect(metadata.previewSummary).toContain("GitHub PRs");
    expect(metadata.previewSummary).not.toContain("hey");
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
    expect(metadata.previewSummary).toContain("Asked:");
    expect(metadata.previewSummary).toContain("artifact preview pane");
  });

  it.each([
    "When does Northstar start?",
    "List the phases in order.",
    "What day does the pilot start and how many testers did I specify?",
  ])("keeps the conversation subject across follow-up: %s", (followUp) => {
    const metadata = buildThreadPresentationMetadata({
      currentTitle: "Plan the Northstar pilot for twelve testers",
      titleSource: "auto",
      messages: [
        {
          role: "user",
          content:
            "Plan the Northstar pilot for twelve testers. It starts Tuesday and has three phases.",
        },
        {
          role: "assistant",
          content:
            "I outlined the Northstar pilot, Tuesday start, and three phases.",
        },
        { role: "user", content: followUp },
        { role: "assistant", content: "Tuesday, with twelve testers." },
      ],
    });

    expect(metadata.title).toBeUndefined();
    expect(metadata.previewSummary).toContain("Started:");
    expect(metadata.previewSummary).toContain("Northstar pilot");
  });

  it("repairs an auto title that mirrors only the latest follow-up", () => {
    const metadata = buildThreadPresentationMetadata({
      currentTitle: "When does Northstar start",
      titleSource: "auto",
      messages: [
        {
          role: "user",
          content:
            "Plan the Northstar pilot for twelve testers. It starts Tuesday.",
        },
        {
          role: "assistant",
          content: "I drafted the Northstar pilot plan.",
        },
        { role: "user", content: "When does Northstar start?" },
        { role: "assistant", content: "It starts Tuesday." },
      ],
    });

    expect(metadata.title).toBe(
      "Plan the Northstar pilot for twelve testers",
    );
  });

  it("upgrades a generic opener when the real subject arrives", () => {
    const metadata = buildThreadPresentationMetadata({
      currentTitle: "Can you help me with this",
      titleSource: "auto",
      messages: [
        { role: "user", content: "Can you help me with this?" },
        { role: "assistant", content: "Absolutely. What are we working on?" },
        {
          role: "user",
          content: "Review the Beacon launch plan and identify its risks.",
        },
        {
          role: "assistant",
          content: "I reviewed the Beacon launch plan and found three risks.",
        },
      ],
    });

    expect(metadata.title).toBe(
      "Review the Beacon launch plan and identify its risks",
    );
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

  it("does not create a preview for low-signal small talk", () => {
    const metadata = buildThreadPresentationMetadata({
      currentTitle: "hello",
      titleSource: "auto",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Hello! How can I help you today?" },
      ],
    });

    expect(metadata.previewSummary).toBeUndefined();
  });
});
