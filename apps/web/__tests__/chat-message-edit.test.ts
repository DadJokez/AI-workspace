import { describe, expect, it } from "vitest";
import {
  isChatMessageEditId,
  planChatMessageEdit,
} from "@/lib/chat-message-edit";

const messages = [
  { id: "user-1", role: "user" as const },
  { id: "assistant-1", role: "assistant" as const },
  { id: "user-2", role: "user" as const },
  { id: "assistant-2", role: "assistant" as const },
];

describe("planChatMessageEdit", () => {
  it("keeps the selected user message and removes the later branch", () => {
    expect(planChatMessageEdit(messages, "user-1")).toEqual({
      ok: true,
      targetId: "user-1",
      deleteIds: ["assistant-1", "user-2", "assistant-2"],
    });
  });

  it("allows editing the latest user message", () => {
    expect(planChatMessageEdit(messages, "user-2")).toEqual({
      ok: true,
      targetId: "user-2",
      deleteIds: ["assistant-2"],
    });
  });

  it("rejects missing and non-user targets", () => {
    expect(planChatMessageEdit(messages, "missing")).toEqual({
      ok: false,
      error: "message_not_found",
    });
    expect(planChatMessageEdit(messages, "assistant-1")).toEqual({
      ok: false,
      error: "message_not_editable",
    });
  });
});

describe("isChatMessageEditId", () => {
  it("accepts stored UUIDs and rejects arbitrary database input", () => {
    expect(isChatMessageEditId("7b2a8572-43f2-4bfb-8d48-bd41d0b48a20")).toBe(
      true,
    );
    expect(isChatMessageEditId("not-a-message-id")).toBe(false);
  });
});
