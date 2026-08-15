import { describe, expect, it } from "vitest";
import { toolCallFingerprint } from "./tool-approval";

describe("toolCallFingerprint", () => {
  it("canonicalizes object keys without ignoring argument changes", async () => {
    const left = await toolCallFingerprint({
      toolName: "google__draft_email",
      input: { subject: "Hello", to: ["a@example.com"] },
    });
    const reordered = await toolCallFingerprint({
      toolName: "google__draft_email",
      input: { to: ["a@example.com"], subject: "Hello" },
    });
    const changed = await toolCallFingerprint({
      toolName: "google__draft_email",
      input: { to: ["b@example.com"], subject: "Hello" },
    });

    expect(left).toBe(reordered);
    expect(left).not.toBe(changed);
  });

  it("binds grants to endpoint and provider-native identity", async () => {
    const base = {
      toolName: "mcp__google__draft_email",
      input: { to: ["a@example.com"] },
    };
    const first = await toolCallFingerprint({
      ...base,
      identity: {
        kind: "mcp",
        provider: "google",
        endpoint: "https://comparative.example/api/mcp/google",
        nativeToolName: "draft_email",
      },
    });
    const otherEndpoint = await toolCallFingerprint({
      ...base,
      identity: {
        kind: "mcp",
        provider: "google",
        endpoint: "https://attacker.example/mcp",
        nativeToolName: "draft_email",
      },
    });

    expect(first).not.toBe(otherEndpoint);
  });
});
