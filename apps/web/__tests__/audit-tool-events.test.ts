import { describe, expect, it } from "vitest";
import { buildToolAuditRows } from "@/lib/audit-tool-events";

describe("buildToolAuditRows", () => {
  const base = {
    actorUserId: "user_1",
    chatThreadId: "thread_1",
    chatMessageId: "message_1",
    modelId: "sonnet-4-6",
    runtime: "cursor",
  };

  it("builds succeeded audit rows for completed tool calls", () => {
    const rows = buildToolAuditRows({
      ...base,
      calls: [
        {
          id: "call_1",
          name: "github_list_pull_requests",
          provider: "github",
          toolName: "list_pull_requests",
          input: { state: "open" },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_1",
          name: "github_list_pull_requests",
          provider: "github",
          toolName: "list_pull_requests",
          output: [{ number: 53 }],
          isError: false,
          completedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    });

    expect(rows).toEqual([
      {
        actorUserId: "user_1",
        actionType: "mcp_tool_execution",
        status: "succeeded",
        provider: "github",
        toolName: "list_pull_requests",
        toolCallId: "call_1",
        chatThreadId: "thread_1",
        chatMessageId: "message_1",
        recipeRunId: null,
        input: { state: "open" },
        output: [{ number: 53 }],
        error: null,
        metadata: {
          rawToolName: "github_list_pull_requests",
          modelId: "sonnet-4-6",
          runtime: "cursor",
        },
        startedAt: new Date("2026-05-15T12:00:00.000Z"),
        completedAt: new Date("2026-05-15T12:00:01.000Z"),
      },
    ]);
  });

  it("builds failed audit rows for error tool results", () => {
    const rows = buildToolAuditRows({
      ...base,
      calls: [
        {
          id: "call_2",
          name: "github.create_issue",
          provider: "github",
          toolName: "create_issue",
          input: { title: "Ship it" },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_2",
          output: { message: "permission denied" },
          isError: true,
          completedAt: "2026-05-15T12:00:02.000Z",
        },
      ],
    });

    expect(rows[0]).toMatchObject({
      status: "failed",
      provider: "github",
      toolName: "create_issue",
      output: null,
      error: '{"message":"permission denied"}',
    });
  });

  it("keeps unmatched results auditable", () => {
    const rows = buildToolAuditRows({
      ...base,
      calls: [],
      results: [
        {
          toolCallId: "call_3",
          output: "late failure",
          isError: true,
          completedAt: "2026-05-15T12:00:03.000Z",
        },
      ],
    });

    expect(rows[0]).toMatchObject({
      status: "failed",
      provider: null,
      toolName: "unknown",
      toolCallId: "call_3",
      input: null,
      error: "late failure",
    });
  });

  it("can link tool execution rows to a recipe run without chat rows", () => {
    const rows = buildToolAuditRows({
      actorUserId: "user_1",
      recipeRunId: "run_1",
      modelId: "sonnet-4-6",
      runtime: "cursor",
      calls: [
        {
          id: "call_4",
          name: "github.search_issues",
          provider: "github",
          toolName: "search_issues",
          input: { q: "review-requested:@me" },
          startedAt: "2026-05-15T12:00:04.000Z",
        },
      ],
      results: [],
    });

    expect(rows[0]).toMatchObject({
      recipeRunId: "run_1",
      chatThreadId: null,
      chatMessageId: null,
      status: "started",
    });
  });
});
