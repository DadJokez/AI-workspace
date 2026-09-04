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
        policyDecision: null,
        metadata: {
          rawToolName: "github_list_pull_requests",
          modelId: "sonnet-4-6",
          runtime: "bedrock",
          autonomyPreset: "interactive",
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

  it("prefers the executor's actual policy decision over observe fallback", () => {
    const rows = buildToolAuditRows({
      ...base,
      toolPolicyDecisions: {
        github__delete_repository: "blocked",
      },
      calls: [
        {
          id: "call_blocked",
          name: "github__delete_repository",
          provider: "github",
          toolName: "delete_repository",
          input: { owner: "example", repo: "private" },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_blocked",
          output: {
            error: "tool_policy_blocked",
            message:
              "Tool github__delete_repository is blocked by runtime policy.",
            tool: "github__delete_repository",
          },
          isError: true,
          policyDecision: "blocked",
          completedAt: "2026-05-15T12:00:00.001Z",
        },
      ],
    });

    expect(rows[0]?.policyDecision).toBe("blocked");
    expect(rows[0]?.status).toBe("failed");
  });

  it("stamps the active autonomy preset beside the policy decision", () => {
    const rows = buildToolAuditRows({
      ...base,
      autonomyPreset: "unattended",
      calls: [
        {
          id: "call_unattended",
          name: "google__create_event",
          provider: "google",
          toolName: "create_event",
          input: { summary: "Planning" },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_unattended",
          output: { error: "tool_approval_unattended_denied" },
          isError: true,
          policyDecision: "denied",
          completedAt: "2026-05-15T12:00:00.001Z",
        },
      ],
    });

    expect(rows[0]).toMatchObject({
      policyDecision: "denied",
      metadata: { autonomyPreset: "unattended" },
    });
  });

  it("stamps domain-policy denials and successful fetched hosts", () => {
    const denied = buildToolAuditRows({
      ...base,
      toolPolicyDecisions: {},
      calls: [
        {
          id: "call_denied",
          name: "web__fetch_url",
          provider: "web",
          toolName: "fetch_url",
          input: { url: "https://blocked.example/" },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_denied",
          output: JSON.stringify({
            error: "web_egress_denied",
            reason: "denied_domain_policy",
            policy: "admin_domain_denylist",
            hostname: "blocked.example",
            matchedDomain: "blocked.example",
          }),
          isError: true,
          completedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    });
    expect(denied[0]?.metadata.webEgress).toEqual({
      outcome: "denied",
      reason: "denied_domain_policy",
      policy: "admin_domain_denylist",
      hostname: "blocked.example",
      matchedDomain: "blocked.example",
    });
    expect(denied[0]?.policyDecision).toBeNull();

    const allowed = buildToolAuditRows({
      ...base,
      toolPolicyDecisions: {},
      calls: [
        {
          id: "call_allowed",
          name: "web__fetch_url",
          provider: "web",
          toolName: "fetch_url",
          input: { url: "https://one.example/" },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_allowed",
          output: { fetchedHosts: ["one.example", "two.example"] },
          isError: false,
          completedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    });
    expect(allowed[0]?.metadata.webEgress).toEqual({
      outcome: "allowed",
      fetchedHosts: ["one.example", "two.example"],
    });
    expect(allowed[0]?.policyDecision).toBeNull();
  });

  it("keeps the loop's auto_allowed stamp on builtin web results (#701)", () => {
    const rows = buildToolAuditRows({
      ...base,
      toolPolicyDecisions: {},
      calls: [
        {
          id: "call_stamped",
          name: "web__fetch_url",
          provider: "web",
          toolName: "fetch_url",
          input: { url: "https://one.example/" },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_stamped",
          output: { fetchedHosts: ["one.example"] },
          isError: false,
          policyDecision: "auto_allowed",
          completedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    });
    expect(rows[0]?.policyDecision).toBe("auto_allowed");
    expect(rows[0]?.status).toBe("succeeded");
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

  it("keeps safe resource validation semantics in audit rows", () => {
    const rows = buildToolAuditRows({
      ...base,
      calls: [
        {
          id: "call_resource_failed",
          name: "resources__query",
          provider: "resources",
          toolName: "query",
          input: {
            redacted: true,
            resourceId: "resource-1",
            operation: "search",
          },
          startedAt: "2026-05-15T12:00:00.000Z",
        },
      ],
      results: [
        {
          toolCallId: "call_resource_failed",
          provider: "resources",
          toolName: "query",
          output:
            'Resource validation error: Operation "search" is not valid for a tabular resource.',
          isError: true,
          completedAt: "2026-05-15T12:00:01.000Z",
        },
      ],
    });

    expect(rows[0]?.error).toBe(
      'Resource validation error: Operation "search" is not valid for a tabular resource.',
    );
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
