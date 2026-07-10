import { describe, expect, it } from "vitest";
import { buildToolAuditRows } from "@/lib/audit-tool-events";

describe("buildToolAuditRows", () => {
  const base = {
    actorUserId: "user_1",
    chatThreadId: "thread_1",
    chatMessageId: "message_1",
    modelId: "sonnet-4-6",
    runtime: "bedrock",
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
        runId: null,
        input: { state: "open" },
        output: [{ number: 53 }],
        error: null,
        metadata: {
          rawToolName: "github_list_pull_requests",
          modelId: "sonnet-4-6",
          runtime: "bedrock",
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

  it("redacts sensitive audit inputs, outputs, and errors", () => {
    const rows = buildToolAuditRows({
      ...base,
      calls: [
        {
          id: "call_secret",
          name: "github_get_secret",
          provider: "github",
          toolName: "get_secret",
          input: {
            q: "repo:example/private",
            Authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345",
          },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_secret",
          output: {
            message: "permission denied",
            access_token: "secret-access-token",
          },
          isError: true,
          completedAt: "2026-05-15T12:00:02.000Z",
        },
      ],
    });

    expect(rows[0]).toMatchObject({
      input: {
        q: "repo:example/private",
        Authorization: "[redacted]",
      },
      output: null,
      error: '{"message":"permission denied","access_token":"[redacted]"}',
    });
  });

  it("redacts successful audit outputs", () => {
    const rows = buildToolAuditRows({
      ...base,
      calls: [],
      results: [
        {
          toolCallId: "call_output",
          output: {
            total: 1,
            token: "secret-token",
          },
          isError: false,
          completedAt: "2026-05-15T12:00:03.000Z",
        },
      ],
    });

    expect(rows[0]?.output).toEqual({
      total: 1,
      token: "[redacted]",
    });
  });

  it("keeps Google audit facts without copying mail or calendar content", () => {
    const rows = buildToolAuditRows({
      ...base,
      calls: [
        {
          id: "call_google",
          name: "google__create_draft",
          provider: "google",
          toolName: "create_draft",
          input: {
            to: ["sam@example.com"],
            subject: "Confidential launch",
            body: "Private body text",
          },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_google",
          provider: "google",
          toolName: "create_draft",
          output: {
            kind: "google_gmail_draft_created",
            draftId: "draft-secret-id",
            sent: false,
          },
          isError: false,
          completedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    });

    expect(rows[0]).toMatchObject({
      provider: "google",
      toolName: "create_draft",
      input: {
        redacted: true,
        recipientCount: 1,
        subjectLength: 19,
        bodyLength: 17,
      },
      output: {
        redacted: true,
        kind: "google_gmail_draft_created",
        sent: false,
      },
    });
    expect(JSON.stringify(rows[0])).not.toContain("sam@example.com");
    expect(JSON.stringify(rows[0])).not.toContain("Private body text");
    expect(JSON.stringify(rows[0])).not.toContain("draft-secret-id");
  });

  it("does not persist provider error text that may contain Google content", () => {
    const rows = buildToolAuditRows({
      ...base,
      calls: [
        {
          id: "call_google_failed",
          name: "google__create_draft",
          provider: "google",
          toolName: "create_draft",
          input: {},
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_google_failed",
          provider: "google",
          toolName: "create_draft",
          output: "Draft for private-recipient@example.com failed.",
          isError: true,
          completedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    });

    expect(rows[0]?.error).toBe(
      "Google tool failed; provider content was redacted from this log.",
    );
    expect(JSON.stringify(rows[0])).not.toContain("private-recipient@example.com");
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

  it("can link tool execution rows to a run without chat rows", () => {
    const rows = buildToolAuditRows({
      actorUserId: "user_1",
      runId: "run_1",
      modelId: "sonnet-4-6",
      runtime: "bedrock",
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
      runId: "run_1",
      chatThreadId: null,
      chatMessageId: null,
      status: "started",
    });
  });
});
