import { describe, expect, it } from "vitest";
import {
  reduceAssistantStreamMessage,
  type UiMessage,
} from "@/app/chat/chat-client-state";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import { buildGuardrailReceipt } from "@/lib/guardrail-receipts";

const pendingMessage = (): UiMessage => ({
  id: "assistant-draft",
  role: "assistant",
  content: "",
  pending: true,
  status: "Thinking…",
});

describe("reduceAssistantStreamMessage", () => {
  it("appends text deltas without dropping prior streamed content", () => {
    const first = reduceAssistantStreamMessage(pendingMessage(), {
      type: "text-delta",
      delta: "Hello",
    });
    const second = reduceAssistantStreamMessage(first, {
      type: "text-delta",
      delta: " world",
    });

    expect(second).toMatchObject({
      content: "Hello world",
      pending: true,
      status: undefined,
      livePhase: "finalizing",
    });
  });

  it("records tool-call and tool-result transitions", () => {
    const call: PersistedToolCall = {
      id: "call-1",
      name: "mcp__github__list_repos",
      provider: "github",
      toolName: "list_repos",
      input: { limit: 3 },
      startedAt: "2026-07-21T00:00:00.000Z",
    };
    const result: PersistedToolResult = {
      toolCallId: call.id,
      name: call.name,
      provider: call.provider,
      toolName: call.toolName,
      output: { repositories: [] },
      isError: false,
      completedAt: "2026-07-21T00:00:01.000Z",
    };

    const calling = reduceAssistantStreamMessage(pendingMessage(), {
      type: "tool-call",
      call,
    });
    const completed = reduceAssistantStreamMessage(calling, {
      type: "tool-result",
      result,
    });

    expect(calling).toMatchObject({
      status: "Calling github · list_repos…",
      livePhase: "using tools",
      toolCalls: [call],
    });
    expect(completed).toMatchObject({
      status: "Working…",
      toolResults: [result],
    });
  });

  it("settles the stream into a reloadable approval wait", () => {
    const requests = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        batchId: "00000000-0000-4000-8000-000000000002",
        toolCallId: "call-1",
        toolName: "mcp__google__draft_email",
        provider: "google",
        nativeToolName: "draft_email",
        redactedInput: { to: ["recipient@example.com"] },
        status: "pending" as const,
      requestedAt: "2026-08-15T00:00:00.000Z",
      expiresAt: "2026-08-16T00:00:00.000Z",
      },
    ];
    const waiting = reduceAssistantStreamMessage(pendingMessage(), {
      type: "tool-approval-required",
      requests,
      runId: "run-1",
    });
    const terminal = reduceAssistantStreamMessage(waiting, {
      type: "complete",
      queued: false,
      waitingForApproval: true,
      runId: "run-1",
    });

    expect(terminal).toMatchObject({
      pending: false,
      runId: "run-1",
      runStatus: "waiting_for_approval",
      canCancel: true,
      approvalRequests: requests,
    });
  });

  it.each(["abort", "error"] as const)(
    "settles the optimistic assistant message on %s",
    (type) => {
      const message = { ...pendingMessage(), content: "Partial answer" };
      expect(reduceAssistantStreamMessage(message, { type })).toMatchObject({
        content: "Partial answer",
        pending: false,
        status: undefined,
      });
    },
  );

  it("replaces streamed content when persisted carries the reduced literal (#652)", () => {
    const streamed = {
      ...pendingMessage(),
      content: "Noted! Here you go: ACK-7",
    };
    expect(
      reduceAssistantStreamMessage(streamed, {
        type: "persisted",
        messageId: "assistant-1",
        content: "ACK-7",
      }),
    ).toMatchObject({
      id: "assistant-1",
      content: "ACK-7",
      pending: false,
    });
  });

  it("keeps streamed content when persisted carries no replacement", () => {
    const streamed = { ...pendingMessage(), content: "Full answer" };
    expect(
      reduceAssistantStreamMessage(streamed, {
        type: "persisted",
        messageId: "assistant-1",
      }),
    ).toMatchObject({
      id: "assistant-1",
      content: "Full answer",
      pending: false,
    });
  });

  it("persists the authoritative selected-context receipt", () => {
    const contextResourceManifest = {
      version: 1 as const,
      items: [
        {
          reference: {
            version: 1 as const,
            kind: "artifact" as const,
            resourceId: "artifact-1",
          },
          label: "Launch brief",
          sourceLabel: "Artifact",
          state: "included" as const,
          contentChars: 42,
        },
      ],
    };

    expect(
      reduceAssistantStreamMessage(pendingMessage(), {
        type: "persisted",
        messageId: "assistant-1",
        contextResourceManifest,
      }),
    ).toMatchObject({
      pending: false,
      contextResourceManifest,
    });
  });

  it("uses the streamed and persisted authoritative guardrail receipt", () => {
    const guardrails = buildGuardrailReceipt({
      runId: "run-guardrails",
      autonomyPreset: "unattended",
      generatedAt: new Date("2026-08-16T12:00:00.000Z"),
    });
    const streamed = reduceAssistantStreamMessage(pendingMessage(), {
      type: "guardrail-receipt",
      receipt: guardrails,
    });
    const persisted = reduceAssistantStreamMessage(streamed, {
      type: "persisted",
      messageId: "assistant-guardrails",
      guardrails,
    });

    expect(streamed.guardrails).toEqual(guardrails);
    expect(persisted).toMatchObject({
      id: "assistant-guardrails",
      pending: false,
      guardrails,
    });
  });
});
