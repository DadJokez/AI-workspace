import { describe, expect, it } from "vitest";
import { mergeLoadedMessages } from "@/app/chat/ChatClient";

describe("chat resume helpers", () => {
  it("keeps in-progress messages when a historical thread finishes loading", () => {
    const loaded = [
      { id: "m1", role: "user" as const, content: "old question" },
      { id: "m2", role: "assistant" as const, content: "old answer" },
    ];
    const current = [
      ...loaded,
      { id: "local-user", role: "user" as const, content: "new follow-up" },
      {
        id: "local-assistant",
        role: "assistant" as const,
        content: "",
        pending: true,
        status: "Thinking...",
      },
    ];

    expect(mergeLoadedMessages(loaded, current)).toEqual(current);
  });

  it("does not duplicate optimistic messages that have already persisted", () => {
    const loaded = [
      { id: "db-user", role: "user" as const, content: "new follow-up" },
      { id: "db-assistant", role: "assistant" as const, content: "answer" },
    ];
    const current = [
      { id: "local-user", role: "user" as const, content: "new follow-up" },
      { id: "local-assistant", role: "assistant" as const, content: "answer" },
    ];

    expect(mergeLoadedMessages(loaded, current)).toEqual(loaded);
  });
});
