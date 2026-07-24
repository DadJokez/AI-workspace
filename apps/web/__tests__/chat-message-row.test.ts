import { createElement } from "react";
import type { MutableRefObject } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "@/app/chat/chat-client-state";
import { MessageBubble } from "@/components/MessageBubble";
import {
  areChatMessageRowPropsEqual,
  type ChatMessageRowActions,
  type ChatMessageRowProps,
} from "@/components/chat/ChatMessageRow";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

const message: UiMessage = {
  id: "assistant-1",
  role: "assistant",
  content: "Stable answer",
  pending: false,
};

function actionRef(): MutableRefObject<ChatMessageRowActions> {
  return {
    current: {
      openArtifact: () => undefined,
      deployAppDraft: () => undefined,
      discardAppProposal: () => undefined,
      iterateAppProposal: () => undefined,
      artifactProposalAction: () => undefined,
      iterateArtifactProposal: () => undefined,
      recommendationAction: () => undefined,
      runAction: () => undefined,
      openRunInspector: () => undefined,
      regenerate: () => undefined,
      edit: () => undefined,
    },
  };
}

function rowProps(
  overrides: Partial<ChatMessageRowProps> = {},
): ChatMessageRowProps {
  return {
    message,
    messageClock: 1_753_280_000_000,
    assistantName: "Thomas",
    isAdmin: false,
    visibleAppDraftVersionIds: "",
    showRegenerate: false,
    editable: false,
    deferOffscreenRendering: true,
    actionsRef: actionRef(),
    ...overrides,
  };
}

describe("chat message row memoization", () => {
  it("reuses an unchanged historical row across parent stream renders", () => {
    const previous = rowProps();
    const next = { ...previous };

    expect(areChatMessageRowPropsEqual(previous, next)).toBe(true);
  });

  it("rerenders the streaming row when its message object changes", () => {
    const previous = rowProps();
    const next = {
      ...previous,
      message: { ...previous.message, content: "Stable answer plus delta" },
    };

    expect(areChatMessageRowPropsEqual(previous, next)).toBe(false);
  });

  it.each<keyof ChatMessageRowProps>([
    "messageClock",
    "assistantName",
    "isAdmin",
    "visibleAppDraftVersionIds",
    "showRegenerate",
    "editable",
    "recommendationPendingId",
    "appDraftPendingId",
    "artifactProposalPendingId",
    "runActionPendingId",
    "deferOffscreenRendering",
    "actionsRef",
  ])("rerenders when %s changes", (property) => {
    const previous = rowProps();
    const replacements: Record<
      Exclude<keyof ChatMessageRowProps, "message">,
      unknown
    > = {
      messageClock: previous.messageClock + 1,
      assistantName: "Ada",
      isAdmin: true,
      visibleAppDraftVersionIds: "version-2",
      showRegenerate: true,
      editable: true,
      recommendationPendingId: "recommendation-1",
      appDraftPendingId: "draft-1",
      artifactProposalPendingId: "artifact-1",
      runActionPendingId: "cancel:run-1",
      deferOffscreenRendering: false,
      actionsRef: actionRef(),
    };
    const next = {
      ...previous,
      [property]: replacements[property as keyof typeof replacements],
    };

    expect(areChatMessageRowPropsEqual(previous, next)).toBe(false);
  });
});

describe("user message attachments", () => {
  it("keeps the filename visible in the optimistic sent bubble", () => {
    const html = renderToString(
      createElement(MessageBubble, {
        role: "user",
        content: "Analyze this.\n\n📎 1 file attached",
        attachmentPreviews: [
          { name: "core-eval-canary.csv", sizeBytes: 42 },
        ],
      }),
    );

    expect(html).toContain('data-testid="message-attachment-pill"');
    expect(html).toContain("core-eval-canary.csv");
  });

  it("keeps distinct same-named uploads visible", () => {
    const html = renderToString(
      createElement(MessageBubble, {
        role: "user",
        content: "Compare these.",
        attachmentPreviews: [
          { name: "report.csv", sizeBytes: 42 },
          { name: "report.csv", sizeBytes: 84 },
        ],
      }),
    );

    expect(html.match(/data-testid="message-attachment-pill"/g)).toHaveLength(2);
    expect(html).toContain("42 B");
    expect(html).toContain("84 B");
  });

  it("rehydrates the filename from the persisted user-upload artifact", () => {
    const artifact: WorkspaceArtifactSummary = {
      id: "artifact-upload",
      title: "core-eval-canary.csv",
      filename: "core-eval-canary.csv",
      kind: "spreadsheet",
      mimeType: "text/csv",
      sizeBytes: 42,
      source: "user-upload",
      threadId: "thread-1",
      chatMessageId: "message-1",
      runId: null,
      artifactGroupId: "artifact-upload",
      versionNumber: 1,
      supersedesArtifactId: null,
      versionSummary: null,
      createdAt: "2026-07-23T12:00:00.000Z",
      previewUrl: "/workspace/artifacts/artifact-upload",
      downloadUrl: "/api/workspace/artifacts/artifact-upload/download",
    };
    const html = renderToString(
      createElement(MessageBubble, {
        role: "user",
        content: "Analyze this.",
        artifacts: [artifact],
        onOpenArtifact: () => undefined,
      }),
    );

    expect(html).toContain("core-eval-canary.csv");
    expect(html).toContain(
      'aria-label="Open attached file core-eval-canary.csv"',
    );
  });
});
