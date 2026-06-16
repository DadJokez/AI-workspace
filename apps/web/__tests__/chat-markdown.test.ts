import { describe, expect, it } from "vitest";
import { escapeBareOrderedListMarkers } from "@/lib/chat-markdown";

describe("escapeBareOrderedListMarkers", () => {
  it("escapes a bare dotted numeric answer", () => {
    expect(escapeBareOrderedListMarkers("42.")).toBe("42\\.");
  });

  it("escapes a bare parenthesized numeric marker", () => {
    expect(escapeBareOrderedListMarkers("3)")).toBe("3\\)");
  });

  it("leaves real numbered lists untouched", () => {
    const markdown = "1. First item\n2. Second item";
    expect(escapeBareOrderedListMarkers(markdown)).toBe(markdown);
  });

  it("leaves four-space indented code untouched", () => {
    const markdown = "    7.";
    expect(escapeBareOrderedListMarkers(markdown)).toBe(markdown);
  });

  it("leaves bare markers inside backtick fences untouched", () => {
    const markdown = "```text\n42.\n```\n\n10.";
    expect(escapeBareOrderedListMarkers(markdown)).toBe(
      "```text\n42.\n```\n\n10\\.",
    );
  });

  it("leaves bare markers inside tilde fences untouched", () => {
    const markdown = "~~~text\n3)\n~~~\n\n3)";
    expect(escapeBareOrderedListMarkers(markdown)).toBe(
      "~~~text\n3)\n~~~\n\n3\\)",
    );
  });

  it("treats an unclosed streaming fence as fenced content", () => {
    const markdown = "```text\n42.\n10.";
    expect(escapeBareOrderedListMarkers(markdown)).toBe(markdown);
  });
});
