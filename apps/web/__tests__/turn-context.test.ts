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

  it("can send only summary plus current message when recent limit is zero", () => {
    const context = buildTurnContext({
      threadSummary: "Earlier context.",
      messages: [msg("user", "old"), msg("user", "current")],
      recentMessageLimit: 0,
    });

    expect(context).toHaveLength(2);
    expect(context[1]).toEqual({ role: "user", content: "current" });
  });
});
