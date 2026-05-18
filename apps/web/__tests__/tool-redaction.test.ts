import { describe, expect, it } from "vitest";
import {
  redactErrorText,
  redactToolCall,
  redactToolPayload,
  redactToolResult,
} from "@/lib/tool-redaction";

describe("tool redaction", () => {
  it("redacts sensitive keys recursively", () => {
    expect(
      redactToolPayload({
        q: "repo:example/private",
        headers: {
          Authorization: "Bearer super-secret-token-value",
          cookie: "session=secret",
        },
        nested: {
          refresh_token: "abc123",
          safe: "keep me",
        },
      }),
    ).toEqual({
      q: "repo:example/private",
      headers: {
        Authorization: "[redacted]",
        cookie: "[redacted]",
      },
      nested: {
        refresh_token: "[redacted]",
        safe: "keep me",
      },
    });
  });

  it("redacts token-shaped string values", () => {
    expect(
      redactToolPayload({
        body: "Bearer abcdefghijklmnopqrstuvwxyz012345",
        github: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        note: "ordinary text",
      }),
    ).toEqual({
      body: "[redacted]",
      github: "[redacted]",
      note: "ordinary text",
    });
  });

  it("truncates large strings and arrays", () => {
    const payload = redactToolPayload({
      text: "a".repeat(2_100),
      items: Array.from({ length: 55 }, (_, i) => i),
    }) as { text: string; items: unknown[] };

    expect(payload.text).toMatch(/\.\.\.\[truncated\]$/);
    expect(payload.items).toHaveLength(51);
    expect(payload.items.at(-1)).toBe("[truncated]");
  });

  it("redacts persisted calls and results", () => {
    expect(
      redactToolCall({
        id: "call_1",
        name: "github_search",
        provider: "github",
        toolName: "search",
        input: { token: "secret", q: "is:pr" },
        startedAt: "2026-05-18T00:00:00.000Z",
      }).input,
    ).toEqual({ token: "[redacted]", q: "is:pr" });

    expect(
      redactToolResult({
        toolCallId: "call_1",
        output: { accessToken: "secret", total: 2 },
        isError: false,
        completedAt: "2026-05-18T00:00:01.000Z",
      }).output,
    ).toEqual({ accessToken: "[redacted]", total: 2 });
  });

  it("redacts error text before audit persistence", () => {
    expect(redactErrorText({ message: "failed", api_key: "secret" })).toBe(
      '{"message":"failed","api_key":"[redacted]"}',
    );
  });
});
