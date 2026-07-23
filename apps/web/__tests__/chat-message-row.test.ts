import { describe, expect, it } from "vitest";
import type { MutableRefObject } from "react";
import type { UiMessage } from "@/app/chat/chat-client-state";
import {
  areChatMessageRowPropsEqual,
  type ChatMessageRowActions,
  type ChatMessageRowProps,
} from "@/components/chat/ChatMessageRow";

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
      artifactProposalAction: () => undefined,
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
