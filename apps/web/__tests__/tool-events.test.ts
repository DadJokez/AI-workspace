import { describe, expect, it } from "vitest";
import {
  createToolEventAccumulator,
  parseToolName,
} from "@/lib/tool-events";

describe("parseToolName", () => {
  it("extracts provider and tool names from common Cursor/MCP names", () => {
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
