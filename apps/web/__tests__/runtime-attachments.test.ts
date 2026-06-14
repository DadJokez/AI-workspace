import { describe, expect, it } from "vitest";
import { attachUploadedFilesToLatestUserMessage } from "@/lib/runtime-attachments";

describe("attachUploadedFilesToLatestUserMessage", () => {
  it("adds runtime image blocks to the latest user message", () => {
    const messages = attachUploadedFilesToLatestUserMessage(
      [
        { role: "user", content: "look at this" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "what changed?" },
      ],
      [
        {
          name: "screen.png",
          sizeBytes: 24,
          mimeType: "image/png",
          runtimeContent: {
            type: "image",
            mimeType: "image/png",
            dataBase64: "abc123",
          },
        },
      ],
    );

    expect(messages[0]?.attachments).toBeUndefined();
    expect(messages[2]?.attachments).toEqual([
      {
        type: "image",
        name: "screen.png",
        mimeType: "image/png",
        dataBase64: "abc123",
      },
    ]);
  });
});
