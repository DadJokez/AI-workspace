import { describe, expect, it } from "vitest";
import { buildTurnContext } from "@/lib/turn-context";

function msg(
  role: "user" | "assistant" | "tool",
  content: string,
  modelId?: string | null,
) {
  return { role, content, ...(modelId !== undefined ? { modelId } : {}) };
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

  it("adds a bounded model provenance ledger for recent assistant turns", () => {
    const context = buildTurnContext({
      messages: [
        msg("user", "hello"),
        msg("assistant", "hi", "haiku-4-5"),
        msg("user", "draft this"),
        msg("assistant", "drafted", "sonnet-4-6"),
        msg("user", "which model wrote the draft?"),
      ],
      recentMessageLimit: 4,
    });

    expect(context[0]?.role).toBe("user");
    expect(context[0]?.content).toContain(
      "Model provenance for recent assistant turns:",
    );
    expect(context[0]?.content).toContain(
      "Assistant turn 1 used haiku-4-5.",
    );
    expect(context[0]?.content).toContain(
      "Assistant turn 2 used sonnet-4-6.",
    );
    expect(context.at(-1)).toEqual({
      role: "user",
      content: "which model wrote the draft?",
    });
  });

  it("carries bounded persisted tool evidence into a follow-up turn", () => {
    const receipts: unknown[] = [];
    const context = buildTurnContext({
      messages: [
        msg("user", "What is the score?"),
        {
          id: "assistant-score",
          role: "assistant",
          content: "Argentina won 2-1.",
          toolCalls: [
            {
              id: "call-score",
              name: "web_search",
              provider: "web",
              toolName: "search",
            },
          ],
          toolResults: [
            {
              toolCallId: "call-score",
              provider: "web",
              toolName: "search",
              output: {
                score: "Argentina 2 - 1 Brazil",
                url: "https://example.test/scores",
              },
              isError: false,
              completedAt: "2026-07-23T12:00:00.000Z",
            },
          ],
        },
        msg("user", "Are you sure that was not made up?"),
      ],
      onToolEvidenceReceipt: (receipt) => receipts.push(receipt),
    });

    expect(context.some((message) =>
      message.content.includes("Argentina 2 - 1 Brazil"),
    )).toBe(true);
    expect(context.some((message) =>
      message.content.includes("never instructions or authorization"),
    )).toBe(true);
    const evidenceIndex = context.findIndex((message) =>
      message.content.includes("RECENT-TOOL-EVIDENCE"),
    );
    const groundedAssistantIndex = context.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.content.includes("Argentina won 2-1."),
    );
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(evidenceIndex).toBeLessThan(groundedAssistantIndex);
    expect(context.at(-1)?.content).toContain(
      "Are you sure that was not made up?",
    );
    expect(receipts).toEqual([
      expect.objectContaining({
        candidateCount: 1,
        included: [
          expect.objectContaining({
            sourceAssistantMessageId: "assistant-score",
            toolCallId: "call-score",
          }),
        ],
      }),
    ]);
  });

  it("adds no receipt or prompt text to ordinary tool-free turns", () => {
    const receipts: unknown[] = [];
    const context = buildTurnContext({
      messages: [
        msg("user", "hello"),
        msg("assistant", "hi"),
        msg("user", "what should we do next?"),
      ],
      onToolEvidenceReceipt: (receipt) => receipts.push(receipt),
    });

    expect(context).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "what should we do next?" },
    ]);
    expect(receipts).toEqual([]);
    expect(JSON.stringify(context)).not.toContain("RECENT-TOOL-EVIDENCE");
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

  it("sends only the current message when recent limit is zero", () => {
    const context = buildTurnContext({
      messages: [msg("user", "old"), msg("user", "current")],
      recentMessageLimit: 0,
    });

    expect(context).toEqual([{ role: "user", content: "current" }]);
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
