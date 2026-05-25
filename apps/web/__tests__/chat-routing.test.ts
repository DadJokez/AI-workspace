import { describe, expect, it } from "vitest";
import { decideChatRuntimeRoute } from "@/lib/chat-routing";

describe("decideChatRuntimeRoute", () => {
  it("defaults simple chat to fast local streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      useWorker: false,
      useMcp: false,
      includeVaultContext: false,
    });
  });

  it("routes explicit cloud requests to the durable cloud worker", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
        executionMode: "cloud",
      }),
    ).toMatchObject({
      lane: "cursor-cloud",
      executionMode: "cloud",
      useWorker: true,
      useMcp: true,
    });
  });

  it("routes GitHub inspection to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Check GitHub issue #123 and summarize it",
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      useWorker: false,
      useMcp: true,
    });
  });

  it("routes implementation work to the durable local worker", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Implement the new settings page and run tests",
      }),
    ).toMatchObject({
      lane: "durable-local",
      executionMode: "local",
      useWorker: true,
      useMcp: true,
    });
  });

  it("keeps personal-context asks local while including vault context", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Based on what you know about my preferences, which option is better?",
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      useWorker: false,
      useMcp: false,
      includeVaultContext: true,
    });
  });
});
