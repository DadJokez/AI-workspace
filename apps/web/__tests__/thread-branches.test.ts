import { describe, expect, it } from "vitest";

import {
  parseThreadBranchRequest,
  parseThreadBranchSnapshot,
  ThreadBranchError,
} from "@/lib/thread-branches";

const threadId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";

describe("thread branch contracts", () => {
  it("accepts a complete message branch request", () => {
    expect(
      parseThreadBranchRequest({
        sourceType: "message",
        sourceThreadId: threadId,
        sourceMessageId: messageId,
      }),
    ).toEqual({
      sourceType: "message",
      sourceThreadId: threadId,
      sourceMessageId: messageId,
    });
  });

  it.each([
    { sourceType: "message", sourceThreadId: threadId },
    { sourceType: "thread" },
    { sourceType: "artifact" },
    { sourceType: "app_version", artifactId: threadId },
    { sourceType: "message", sourceThreadId: "not-a-uuid", sourceMessageId: messageId },
  ])("rejects incomplete or malformed branch requests", (request) => {
    expect(() => parseThreadBranchRequest(request)).toThrow(ThreadBranchError);
  });

  it("parses a complete immutable snapshot and rejects partial entries", () => {
    const snapshot = {
      version: 1,
      sourceTitle: "Quarterly plan",
      messages: [
        {
          id: messageId,
          sourceMessageIdSnapshot: messageId,
          originMessageIdSnapshot: messageId,
          originThreadIdSnapshot: threadId,
          role: "user",
          content: "Try the enterprise angle.",
          modelId: null,
          runtime: null,
          tokensIn: null,
          tokensOut: null,
          createdAt: "2026-08-11T12:00:00.000Z",
        },
      ],
      resources: [],
    };

    expect(parseThreadBranchSnapshot(snapshot)).toEqual(snapshot);
    expect(
      parseThreadBranchSnapshot({
        ...snapshot,
        messages: [{ ...snapshot.messages[0], content: undefined }],
      }),
    ).toBeNull();
  });
});
