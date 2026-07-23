import { describe, expect, it } from "vitest";
import {
  createToolEventAccumulator,
  parseToolName,
} from "@/lib/tool-events";

describe("parseToolName", () => {
  it("extracts provider and tool names from common provider/MCP names", () => {
    expect(parseToolName("github.list_pull_requests")).toEqual({
      provider: "github",
      toolName: "list_pull_requests",
    });
    expect(parseToolName("github/create_issue")).toEqual({
      provider: "github",
      toolName: "create_issue",
    });
    expect(parseToolName("github__search_repositories")).toEqual({
      provider: "github",
      toolName: "search_repositories",
    });
    expect(parseToolName("mcp__github__list_pull_requests")).toEqual({
      provider: "github",
      toolName: "list_pull_requests",
    });
  });

  it("uses connected provider hints for underscore-prefixed tool names", () => {
    expect(parseToolName("github_list_pull_requests", ["github"])).toEqual({
      provider: "github",
      toolName: "list_pull_requests",
    });
  });

  it("keeps bare tool names when no provider can be inferred", () => {
    expect(parseToolName("list_pull_requests", ["github"])).toEqual({
      provider: null,
      toolName: "list_pull_requests",
    });
  });
});

describe("createToolEventAccumulator", () => {
  it("records calls and enriches matching results with provider metadata", () => {
    const timestamps = [
      new Date("2026-05-15T10:00:00.000Z"),
      new Date("2026-05-15T10:00:01.000Z"),
    ];
    const acc = createToolEventAccumulator(["github"], () => timestamps.shift()!);

    acc.recordCall({
      id: "call_1",
      name: "github_list_pull_requests",
      input: { state: "open" },
    });
    acc.recordResult({
      toolCallId: "call_1",
      output: [{ number: 50 }],
    });

    expect(acc.calls()).toEqual([
      {
        id: "call_1",
        name: "github_list_pull_requests",
        provider: "github",
        toolName: "list_pull_requests",
        input: { state: "open" },
        startedAt: "2026-05-15T10:00:00.000Z",
      },
    ]);
    expect(acc.results()).toEqual([
      {
        toolCallId: "call_1",
        name: "github_list_pull_requests",
        provider: "github",
        toolName: "list_pull_requests",
        output: [{ number: 50 }],
        isError: false,
        completedAt: "2026-05-15T10:00:01.000Z",
      },
    ]);
  });

  it("redacts sensitive tool payloads before they are persisted", () => {
    const acc = createToolEventAccumulator(["github"], () =>
      new Date("2026-05-15T10:00:00.000Z"),
    );

    acc.recordCall({
      id: "call_secret",
      name: "github_create_issue",
      input: {
        title: "Safe title",
        Authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345",
      },
    });
    acc.recordResult({
      toolCallId: "call_secret",
      output: {
        id: 123,
        refresh_token: "secret-refresh-token",
      },
    });

    expect(acc.calls()[0]?.input).toEqual({
      title: "Safe title",
      Authorization: "[redacted]",
    });
    expect(acc.results()[0]?.output).toEqual({
      id: 123,
      refresh_token: "[redacted]",
    });
  });

  it("persists resource calls as compact receipts without file content", () => {
    const acc = createToolEventAccumulator(["resources"], () =>
      new Date("2026-05-15T10:00:00.000Z"),
    );

    acc.recordCall({
      id: "resource_call",
      name: "resources__query",
      input: {
        resourceId: "resource-1",
        operation: "search",
        query: "confidential phrase",
      },
    });
    acc.recordResult({
      toolCallId: "resource_call",
      output: {
        kind: "conversation_resource_result",
        receipt: {
          resourceId: "resource-1",
          operation: "search",
          sourceCoverage: "full",
        },
        matches: [{ text: "confidential phrase from the source file" }],
      },
    });

    expect(acc.calls()[0]?.input).toEqual({
      redacted: true,
      resourceId: "resource-1",
      operation: "search",
      fields: ["operation", "query", "resourceId"],
    });
    expect(acc.results()[0]?.output).toMatchObject({
      redacted: true,
      kind: "conversation_resource_result",
      receipt: {
        resourceId: "resource-1",
        operation: "search",
        sourceCoverage: "full",
      },
      resultKeys: ["kind", "matches", "receipt"],
    });
    expect(JSON.stringify(acc.results())).not.toContain("confidential");
  });

  it("preserves error results even when the matching call was not seen", () => {
    const acc = createToolEventAccumulator([], () =>
      new Date("2026-05-15T10:00:02.000Z"),
    );

    acc.recordResult({
      toolCallId: "missing_call",
      output: "permission denied",
      isError: true,
    });

    expect(acc.results()).toEqual([
      {
        toolCallId: "missing_call",
        output: "permission denied",
        isError: true,
        completedAt: "2026-05-15T10:00:02.000Z",
      },
    ]);
  });
});
