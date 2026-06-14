import { describe, expect, it } from "vitest";
import { parseChatExecutionMode } from "@/lib/chat-execution-mode";

describe("parseChatExecutionMode", () => {
  it("defaults missing or unknown values to local", () => {
    expect(parseChatExecutionMode(undefined)).toBe("local");
    expect(parseChatExecutionMode(null)).toBe("local");
    expect(parseChatExecutionMode("")).toBe("local");
    expect(parseChatExecutionMode("LOCAL")).toBe("local");
    expect(parseChatExecutionMode("bedrock")).toBe("local");
  });

  it("treats removed cloud execution as local", () => {
    expect(parseChatExecutionMode("cloud")).toBe("local");
  });
});
