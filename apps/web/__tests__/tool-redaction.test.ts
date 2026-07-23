import { describe, expect, it } from "vitest";
import {
  redactErrorText,
  redactProviderToolPayload,
  redactTracePayload,
  redactToolCall,
  redactToolPayload,
  redactToolResult,
} from "@/lib/tool-redaction";

describe("tool redaction", () => {
  it("keeps longer trace text while applying the same secret rules", () => {
    const longText = "a".repeat(3_000);
    const redacted = redactTracePayload({
      prompt: longText,
      authorization: "Bearer secret-value",
    }) as Record<string, unknown>;

    expect(redacted.prompt).toBe(longText);
    expect(redacted.authorization).toBe("[redacted]");
  });

  it("redacts credentials embedded inside ordinary trace text", () => {
    const redacted = redactTracePayload({
      prompt:
        "Use Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 and client_secret=do-not-store-this-value.",
    }) as Record<string, string>;

    expect(redacted.prompt).toContain("Bearer [redacted]");
    expect(redacted.prompt).toContain("client_secret=[redacted]");
    expect(redacted.prompt).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted.prompt).not.toContain("do-not-store-this-value");
  });

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

  it("preserves first-token timing telemetry (#387)", () => {
    expect(
      redactTracePayload({
        metrics: {
          firstTokenAt: "2026-07-15T01:00:01.250Z",
          requestToFirstTokenMs: 1250,
          providerToFirstTokenMs: 900,
        },
        tokensIn: 1050,
      }),
    ).toEqual({
      metrics: {
        firstTokenAt: "2026-07-15T01:00:01.250Z",
        requestToFirstTokenMs: 1250,
        providerToFirstTokenMs: 900,
      },
      tokensIn: 1050,
    });
  });

  it("still redacts credentials smuggled under telemetry names (#387)", () => {
    expect(
      redactTracePayload({
        // The allowlist is key AND value shape: a string that is not a
        // short ISO timestamp keeps the sensitive-key treatment.
        firstTokenAt: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
        requestToFirstTokenMs: "Bearer abc.def.ghi",
        accessToken: 12345,
      }),
    ).toEqual({
      firstTokenAt: "[redacted]",
      requestToFirstTokenMs: "[redacted]",
      accessToken: "[redacted]",
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

  it("keeps resource coverage receipts but never file excerpts or rows", () => {
    const redacted = redactProviderToolPayload({
      provider: "resources",
      toolName: "query",
      direction: "output",
      value: {
        kind: "conversation_resource_result",
        receipt: {
          resourceId: "resource-1",
          operation: "search",
          sourceCoverage: "full",
          sourceChars: 9_000_000,
        },
        content: "confidential file text",
        rows: [{ customer: "Secret Customer", revenue: 42 }],
      },
    });

    expect(redacted).toMatchObject({
      redacted: true,
      kind: "conversation_resource_result",
      receipt: {
        resourceId: "resource-1",
        operation: "search",
        sourceCoverage: "full",
        sourceChars: 9_000_000,
      },
      resultKeys: ["content", "kind", "receipt", "rows"],
    });
    expect(JSON.stringify(redacted)).not.toContain("confidential");
    expect(JSON.stringify(redacted)).not.toContain("Secret Customer");
  });
});
