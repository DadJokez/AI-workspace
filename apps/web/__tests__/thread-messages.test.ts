import { describe, expect, it } from "vitest";
import { activeRunMessageContent } from "@/lib/thread-messages";

describe("activeRunMessageContent", () => {
  it("hides interrupted artifact snippets behind a clear retry message", () => {
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
});
