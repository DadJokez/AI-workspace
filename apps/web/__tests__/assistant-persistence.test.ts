import { describe, expect, it } from "vitest";
import { shouldPersistAssistantMessage } from "@/lib/assistant-persistence";

describe("shouldPersistAssistantMessage", () => {
  it("does not save empty failed assistant messages", () => {
    expect(
      shouldPersistAssistantMessage({
        terminalStatus: "failed",
        assistantText: "",
        toolCallsCount: 0,
        toolResultsCount: 0,
      }),
    ).toBe(false);
  });

  it("saves successful messages even when the text is empty", () => {
    expect(
      shouldPersistAssistantMessage({
        terminalStatus: "succeeded",
        assistantText: "",
        toolCallsCount: 0,
        toolResultsCount: 0,
      }),
    ).toBe(true);
  });

  it("saves failed messages when there is visible text or tool activity", () => {
    expect(
      shouldPersistAssistantMessage({
        terminalStatus: "failed",
        assistantText: "Partial answer",
        toolCallsCount: 0,
        toolResultsCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldPersistAssistantMessage({
        terminalStatus: "failed",
        assistantText: "",
        toolCallsCount: 1,
        toolResultsCount: 0,
      }),
    ).toBe(true);
  });
});
