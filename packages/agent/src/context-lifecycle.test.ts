import { describe, expect, it } from "vitest";
import type { BedrockMessage } from "./clients";
import {
  CLEARED_TOOL_RESULT_MARKER,
  clearStaleToolResults,
} from "./context-lifecycle";
import { frameUntrustedToolResult } from "./tool-result-framing";

function round(
  index: number,
  {
    content = `payload-${index} ${"x".repeat(2000)}`,
    isError = false,
    name = `tool_${index}`,
  }: { content?: string; isError?: boolean; name?: string } = {},
): BedrockMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { kind: "tool-use", id: `call-${index}`, name, input: { q: index } },
      ],
    },
    {
      role: "user",
      content: [
        {
          kind: "tool-result",
          toolUseId: `call-${index}`,
          content,
          ...(isError ? { isError: true } : {}),
        },
      ],
    },
  ];
}

function transcript(rounds: number, opts: Parameters<typeof round>[1] = {}) {
  return [
    { role: "user", content: [{ kind: "text", text: "do the thing" }] },
    ...Array.from({ length: rounds }, (_, i) => round(i + 1, opts)).flat(),
  ] satisfies BedrockMessage[];
}

function resultContent(messages: BedrockMessage[], toolUseId: string): string {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.kind === "tool-result" && block.toolUseId === toolUseId) {
        return block.content;
      }
    }
  }
  throw new Error(`missing tool result ${toolUseId}`);
}

describe("clearStaleToolResults (#771 stage 1)", () => {
  it("leaves a transcript under the trigger untouched", () => {
    const messages = transcript(4);
    const { messages: out, receipt } = clearStaleToolResults(messages, {
      keepRecentRounds: 1,
      triggerChars: 1_000_000,
    });
    expect(out).toEqual(messages);
    expect(receipt.cleared).toEqual([]);
    expect(receipt.transcriptCharsAfter).toBe(receipt.transcriptCharsBefore);
  });

  it("stubs rounds older than the keep window, oldest first, until the transcript fits", () => {
    const messages = transcript(4);
    const before = clearStaleToolResults(messages, { triggerChars: 0 })
      .receipt.transcriptCharsBefore;
    // Trigger just below the full size: clearing the oldest round is enough.
    const { messages: out, receipt } = clearStaleToolResults(messages, {
      keepRecentRounds: 2,
      triggerChars: before - 50,
    });
    expect(receipt.cleared.map((c) => c.toolUseId)).toEqual(["call-1"]);
    expect(resultContent(out, "call-1")).toContain(CLEARED_TOOL_RESULT_MARKER);
    expect(resultContent(out, "call-2")).toContain("payload-2");
    expect(resultContent(out, "call-3")).toContain("payload-3");
    expect(resultContent(out, "call-4")).toContain("payload-4");
    expect(receipt.transcriptCharsAfter).toBeLessThan(before);
  });

  it("never clears the most recent rounds, even when the transcript still exceeds the trigger", () => {
    const messages = transcript(4);
    const { messages: out, receipt } = clearStaleToolResults(messages, {
      keepRecentRounds: 2,
      triggerChars: 1,
    });
    expect(receipt.cleared.map((c) => c.toolUseId)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(resultContent(out, "call-3")).toContain("payload-3");
    expect(resultContent(out, "call-4")).toContain("payload-4");
  });

  it("keeps tool name, call id, outcome, and a one-line excerpt in the placeholder", () => {
    const messages = transcript(3, { name: "github__list_prs" });
    const { messages: out } = clearStaleToolResults(messages, {
      keepRecentRounds: 1,
      triggerChars: 0,
    });
    const placeholder = resultContent(out, "call-1");
    expect(placeholder.startsWith(CLEARED_TOOL_RESULT_MARKER)).toBe(true);
    expect(placeholder).toContain("tool=github__list_prs");
    expect(placeholder).toContain("call=call-1");
    expect(placeholder).toContain("outcome=ok");
    expect(placeholder).toContain("excerpt: payload-1");
    expect(placeholder).toContain("re-run the tool if the exact data is needed");
    // Bounded: the 2000-char filler does not survive whole.
    expect(placeholder.length).toBeLessThan(400);
  });

  it("never rewrites an error result, however stale or large", () => {
    const error = `tool_approval_denied: Permission to run crm__delete was denied by the user. ${"detail ".repeat(400)}`;
    const messages = [
      ...transcript(1, { content: error, isError: true }),
      ...round(2),
      ...round(3),
    ];
    const { messages: out, receipt } = clearStaleToolResults(messages, {
      keepRecentRounds: 1,
      triggerChars: 0,
    });
    expect(resultContent(out, "call-1")).toBe(error);
    const block = out
      .flatMap((m) => m.content)
      .find((b) => b.kind === "tool-result" && b.toolUseId === "call-1");
    expect(block && block.kind === "tool-result" && block.isError).toBe(true);
    expect(receipt.cleared.map((c) => c.toolUseId)).toEqual(["call-2"]);
  });

  it("excerpts the payload, not the #497 data-framing scaffolding", () => {
    const framed = frameUntrustedToolResult(
      "crm__get_notes",
      JSON.stringify({ notes: "quarterly review moved to Friday" }),
    );
    const messages = [
      ...transcript(1, { content: framed, name: "crm__get_notes" }),
      ...round(2),
    ];
    const { messages: out } = clearStaleToolResults(messages, {
      keepRecentRounds: 1,
      triggerChars: 0,
    });
    const placeholder = resultContent(out, "call-1");
    expect(placeholder).toContain("quarterly review moved to Friday");
    expect(placeholder).not.toContain("<<<TOOL-RESULT");
    expect(placeholder).not.toContain("Tool result from crm__get_notes");
  });

  it("is idempotent and does not mutate its input", () => {
    const messages = transcript(3);
    const snapshot = JSON.stringify(messages);
    const first = clearStaleToolResults(messages, {
      keepRecentRounds: 1,
      triggerChars: 0,
    });
    const second = clearStaleToolResults(first.messages, {
      keepRecentRounds: 1,
      triggerChars: 0,
    });
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(second.receipt.cleared).toEqual([]);
    expect(second.messages).toEqual(first.messages);
  });

  it("leaves a payload alone when its placeholder would not be shorter", () => {
    const messages = [
      ...transcript(1, { content: "tiny" }),
      ...round(2),
      ...round(3),
    ];
    const { messages: out, receipt } = clearStaleToolResults(messages, {
      keepRecentRounds: 1,
      triggerChars: 0,
    });
    expect(resultContent(out, "call-1")).toBe("tiny");
    expect(receipt.cleared.map((c) => c.toolUseId)).toEqual(["call-2"]);
  });

  it("counts a message with several tool results as one round", () => {
    const messages: BedrockMessage[] = [
      { role: "user", content: [{ kind: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { kind: "tool-use", id: "a", name: "t", input: {} },
          { kind: "tool-use", id: "b", name: "t", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { kind: "tool-result", toolUseId: "a", content: "A".repeat(2000) },
          { kind: "tool-result", toolUseId: "b", content: "B".repeat(2000) },
        ],
      },
      ...round(2),
    ];
    const { receipt } = clearStaleToolResults(messages, {
      keepRecentRounds: 1,
      triggerChars: 0,
    });
    expect(receipt.cleared.map((c) => c.toolUseId)).toEqual(["a", "b"]);
  });
});
