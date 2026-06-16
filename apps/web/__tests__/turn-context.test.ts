import { describe, expect, it } from "vitest";
import { buildTurnContext } from "@/lib/turn-context";

function msg(role: "user" | "assistant" | "tool", content: string) {
  return { role, content };
}

describe("buildTurnContext", () => {
  it("returns no messages when there is no persisted current turn", () => {
    expect(buildTurnContext({ messages: [] })).toEqual([]);
  });

  it("preserves the current user message exactly", () => {
    const current = "  Keep my spacing\nand punctuation?!  ";
    const context = buildTurnContext({
      messages: [
        msg("user", "old"),
        msg("assistant", "older"),
        msg("user", current),
      ],
      recentMessageLimit: 1,
    });

    expect(context.at(-1)).toEqual({ role: "user", content: current });
  });

  it("can replace the current turn with composed model-facing content", () => {
    const context = buildTurnContext({
      messages: [
        msg("assistant", "prior answer"),
        msg("user", "i attached it"),
      ],
      currentMessageContent:
        "i attached it\n\n--- Attached files ---\nAttached file: demo.html\n```html\n<html>visible to model</html>\n```",
      recentMessageLimit: 1,
    });

    expect(context).toEqual([
      { role: "assistant", content: "prior answer" },
      {
        role: "user",
        content: expect.stringContaining("<html>visible to model</html>"),
      },
    ]);
  });

  it("includes only the bounded recent history before the current turn", () => {
    const context = buildTurnContext({
      messages: [
        msg("user", "u1"),
        msg("assistant", "a1"),
        msg("user", "u2"),
        msg("assistant", "a2"),
        msg("user", "current"),
      ],
      recentMessageLimit: 2,
    });

    expect(context).toEqual([
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "current" },
    ]);
  });

  it("drops blank historical messages and coalesces adjacent user turns", () => {
    const context = buildTurnContext({
      messages: [
        msg("user", "look at this site"),
        msg("assistant", ""),
        msg("user", "anything?"),
      ],
    });

    expect(context).toEqual([
      { role: "user", content: "look at this site\n\nanything?" },
    ]);
  });

  it("coalesces summary context with adjacent user history", () => {
    const context = buildTurnContext({
      threadSummary: "Earlier context.",
      messages: [msg("user", "old"), msg("assistant", ""), msg("user", "current")],
    });

    expect(context).toEqual([
      {
        role: "user",
        content: expect.stringContaining(
          "Conversation summary from earlier turns:",
        ),
      },
    ]);
    expect(context[0]?.content).toContain("Earlier context.");
    expect(context[0]?.content).toContain("old");
    expect(context[0]?.content).toContain("current");
  });

  it("prepends a non-empty thread summary as background context", () => {
    const context = buildTurnContext({
      threadSummary: "The user is planning a deploy workflow.",
      messages: [msg("assistant", "prior"), msg("user", "current")],
      recentMessageLimit: 1,
    });

    expect(context[0]?.role).toBe("user");
    expect(context[0]?.content).toContain("Conversation summary");
    expect(context[0]?.content).toContain("deploy workflow");
    expect(context.slice(1)).toEqual([
      { role: "assistant", content: "prior" },
      { role: "user", content: "current" },
    ]);
  });

  it("can send only merged summary plus current message when recent limit is zero", () => {
    const context = buildTurnContext({
      threadSummary: "Earlier context.",
      messages: [msg("user", "old"), msg("user", "current")],
      recentMessageLimit: 0,
    });

    expect(context).toHaveLength(1);
    expect(context[0]?.role).toBe("user");
    expect(context[0]?.content).toContain("Earlier context.");
    expect(context[0]?.content).toContain("current");
  });

  it("drops oldest recent messages when the context budget is reached", () => {
    const events: unknown[] = [];
    const context = buildTurnContext({
      messages: [
        msg("user", "old message that will not fit"),
        msg("assistant", "newer"),
        msg("user", "current"),
      ],
      recentMessageLimit: 2,
      maxContextChars: 14,
      onGuardrailEvent: (event) => events.push(event),
    });

    expect(context).toEqual([
      { role: "assistant", content: "newer" },
      { role: "user", content: "current" },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "history_dropped",
        droppedMessages: 1,
      }),
    );
  });

  it("truncates oversized prior messages deterministically", () => {
    const events: unknown[] = [];
    const oversized = "abcdefghijklmnopqrstuvwxyz".repeat(5);
    const context = buildTurnContext({
      messages: [
        msg("assistant", oversized),
        msg("user", "current"),
      ],
      recentMessageLimit: 1,
      maxMessageChars: 80,
      onGuardrailEvent: (event) => events.push(event),
    });

    expect(context[0]?.content).toContain(
      "[Message truncated for prompt budget]",
    );
    expect(context[0]?.content.startsWith("a")).toBe(true);
    expect(context[0]?.content.endsWith("z")).toBe(true);
    expect(context.at(-1)).toEqual({ role: "user", content: "current" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_truncated",
        originalChars: oversized.length,
      }),
    );
  });

  it("preserves the current message even when it exceeds the total budget", () => {
    const events: unknown[] = [];
    const current = "current message is intentionally longer than budget";
    const context = buildTurnContext({
      messages: [msg("assistant", "prior"), msg("user", current)],
      maxContextChars: 10,
      onGuardrailEvent: (event) => events.push(event),
    });

    expect(context).toEqual([{ role: "user", content: current }]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "context_budget_exceeded",
      }),
    );
  });
});
