import { describe, expect, it } from "vitest";
import {
  decideChatRuntimeRoute,
  runtimeV2EnabledFromEnv,
} from "@/lib/chat-routing";

describe("decideChatRuntimeRoute", () => {
  it("defaults simple chat to fast local streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      runtimeV2: false,
      useWorker: false,
      useMcp: false,
      includeVaultContext: false,
    });
  });

  it("routes simple Runtime V2 chat to direct local streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      runtimeTarget: "direct-chat",
      runtimeV2: true,
      useWorker: false,
      useMcp: false,
      includeVaultContext: false,
      reasons: ["default_fast_local"],
    });
  });

  it("accepts production Runtime V2 flag values", () => {
    expect(runtimeV2EnabledFromEnv("1")).toBe(true);
    expect(runtimeV2EnabledFromEnv("true")).toBe(true);
    expect(runtimeV2EnabledFromEnv("yes")).toBe(true);
    expect(runtimeV2EnabledFromEnv("on")).toBe(true);
    expect(runtimeV2EnabledFromEnv("0")).toBe(false);
    expect(runtimeV2EnabledFromEnv(undefined)).toBe(false);
  });

  it("routes explicit cloud requests to the durable cloud worker", () => {
    expect(
      decideChatRuntimeRoute({
        message: "say pong and nothing else",
        executionMode: "cloud",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "cursor-cloud",
      executionMode: "cloud",
      runtimeTarget: "cursor-agent",
      useWorker: true,
      useMcp: true,
    });
  });

  it("routes GitHub inspection to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Check GitHub issue #123 and summarize it",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: false,
      useMcp: true,
    });
  });

  it("routes GitHub shorthand PR summaries to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Can you take a peek in my Gh and summarize the last 3 prs",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: false,
      useMcp: true,
    });
  });

  it("routes GitHub capability probes to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "You can't access git hub",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_capability_probe"],
    });
  });

  it("routes connected-tool repo visibility checks to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Tools says it's connected. Try if you can see my repos.",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_capability_probe"],
    });
  });

  it("routes natural personal PR review prompts to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "What PRs am I reviewing?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_owned_work_lookup"],
    });
  });

  it("routes CI status checks to local tool streaming", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Anything failing CI?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_ci_status_lookup"],
    });
  });

  it("treats numbered PR lookup as tool work, not durable PR creation", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Open PR #123 and summarize it",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["github_numbered_reference"],
    });
  });

  it("does not mount tools for generic educational PR questions", () => {
    expect(
      decideChatRuntimeRoute({
        message: "What is a pull request?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
    });
  });

  it("does not mount tools for generic issue wording without work-system intent", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Show me the issues with this plan",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
    });
  });

  it("routes implementation work to the durable local worker", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Implement the new settings page and run tests",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "durable-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: true,
      useMcp: true,
    });
  });

  it("keeps personal-context asks local while including vault context", () => {
    expect(
      decideChatRuntimeRoute({
        message: "Based on what you know about my preferences, which option is better?",
        runtimeV2: true,
      }),
    ).toMatchObject({
      lane: "fast-local",
      executionMode: "local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
      includeVaultContext: true,
    });
  });

  // Conversation-level tool stickiness. Born from a real failure: the model
  // answered "no GitHub issues", then a turn later — asked "what repos did you
  // check?" — said "I don't actually have access to GitHub". The follow-up had
  // no tool keywords so it dropped to the tool-less fast lane and contradicted
  // itself. Stickiness keeps GitHub mounted across the thread.
  it("keeps tools mounted on a follow-up after a thread already used them", () => {
    expect(
      decideChatRuntimeRoute({
        message: "what did you check?",
        runtimeV2: true,
        priorUserMessages: [
          "Open GitHub issues assigned to me — what should I tackle first?",
        ],
      }),
    ).toMatchObject({
      lane: "tool-local",
      executionMode: "local",
      runtimeTarget: "cursor-agent",
      useWorker: false,
      useMcp: true,
      reasons: ["sticky_tool_thread"],
    });
  });

  it("does not stick tools when no earlier turn needed them", () => {
    expect(
      decideChatRuntimeRoute({
        message: "what did you check?",
        runtimeV2: true,
        priorUserMessages: ["tell me a joke", "now make it shorter"],
      }),
    ).toMatchObject({
      lane: "fast-local",
      runtimeTarget: "direct-chat",
      useWorker: false,
      useMcp: false,
    });
  });

  it("stickiness upgrades a follow-up to inline tools, never the durable worker", () => {
    // A prior durable turn shouldn't force every later chit-chat turn into the
    // background worker — keep tools warm inline instead.
    expect(
      decideChatRuntimeRoute({
        message: "thanks — what did that change?",
        runtimeV2: true,
        priorUserMessages: ["Implement the new settings page and run tests"],
      }),
    ).toMatchObject({
      lane: "tool-local",
      useWorker: false,
      useMcp: true,
      reasons: ["sticky_tool_thread"],
    });
  });
});
