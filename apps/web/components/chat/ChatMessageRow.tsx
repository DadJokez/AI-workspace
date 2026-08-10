"use client";

import type { ChatEditRequest } from "@/components/ChatInput";
import { MessageBubble } from "@/components/MessageBubble";
import type { UiMessage } from "@/app/chat/chat-client-state";
import type { AppDraftVersionSummary } from "@/lib/app-draft-versions";
import { stripAttachmentNoteFromMessage } from "@/lib/attachments";
import type {
  PersistedRecommendation,
  RecommendationStatus,
} from "@/lib/recommendations";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type { OutputProposalDecision } from "@/lib/output-proposals";
import {
  memo,
  type CSSProperties,
  type MutableRefObject,
} from "react";

const OFFSCREEN_MESSAGE_STYLE = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 64px",
} satisfies CSSProperties;

export interface ChatMessageRowActions {
  openArtifact: (artifact: WorkspaceArtifactSummary) => void;
  deployAppDraft: (version: AppDraftVersionSummary) => void;
  discardAppProposal: (version: AppDraftVersionSummary) => void;
  iterateAppProposal: (
    version: AppDraftVersionSummary,
    feedback: string,
  ) => void;
  artifactProposalAction: (
    artifact: WorkspaceArtifactSummary,
    decision: OutputProposalDecision,
  ) => void;
  iterateArtifactProposal: (
    artifact: WorkspaceArtifactSummary,
    feedback: string,
  ) => void;
  recommendationAction: (
    recommendation: PersistedRecommendation,
    status: RecommendationStatus,
  ) => void;
  runAction: (
    runId: string,
    action: "cancel" | "retry" | "resume",
  ) => void;
  openRunInspector: (runId: string) => void;
  regenerate: () => void;
  edit: (request: ChatEditRequest) => void;
}

export interface ChatMessageRowProps {
  message: UiMessage;
  messageClock: number;
  assistantName?: string | null;
  isAdmin: boolean;
  visibleAppDraftVersionIds: string;
  showRegenerate: boolean;
  editable: boolean;
  recommendationPendingId?: string;
  appDraftPendingId?: string;
  artifactProposalPendingId?: string;
  runActionPendingId?: string;
  deferOffscreenRendering: boolean;
  actionsRef: MutableRefObject<ChatMessageRowActions>;
}

export function areChatMessageRowPropsEqual(
  previous: ChatMessageRowProps,
  next: ChatMessageRowProps,
): boolean {
  return (
    previous.message === next.message &&
    previous.messageClock === next.messageClock &&
    previous.assistantName === next.assistantName &&
    previous.isAdmin === next.isAdmin &&
    previous.visibleAppDraftVersionIds === next.visibleAppDraftVersionIds &&
    previous.showRegenerate === next.showRegenerate &&
    previous.editable === next.editable &&
    previous.recommendationPendingId === next.recommendationPendingId &&
    previous.appDraftPendingId === next.appDraftPendingId &&
    previous.artifactProposalPendingId === next.artifactProposalPendingId &&
    previous.runActionPendingId === next.runActionPendingId &&
    previous.deferOffscreenRendering === next.deferOffscreenRendering &&
    previous.actionsRef === next.actionsRef
  );
}

function ChatMessageRowComponent({
  message,
  messageClock,
  assistantName,
  isAdmin,
  visibleAppDraftVersionIds,
  showRegenerate,
  editable,
  recommendationPendingId,
  appDraftPendingId,
  artifactProposalPendingId,
  runActionPendingId,
  deferOffscreenRendering,
  actionsRef,
}: ChatMessageRowProps) {
  const visibleDraftIds = new Set(
    visibleAppDraftVersionIds
      ? visibleAppDraftVersionIds.split("\u0000")
      : [],
  );

  return (
    <div
      data-testid="chat-message-row"
      data-message-id={message.id}
      className="flex flex-col gap-2"
      style={deferOffscreenRendering ? OFFSCREEN_MESSAGE_STYLE : undefined}
    >
      <MessageBubble
        role={message.role}
        content={message.content}
        createdAt={message.createdAt}
        nowMs={messageClock}
        modelId={message.modelId}
        tokensIn={message.tokensIn}
        tokensOut={message.tokensOut}
        pending={message.pending}
        status={message.status}
        attachmentPreviews={message.attachmentPreviews}
        livePhase={message.livePhase}
        liveTokens={message.liveTokens}
        toolCalls={message.toolCalls}
        toolResults={message.toolResults}
        artifacts={message.artifacts}
        appDraftVersions={message.appDraftVersions?.filter((version) =>
          visibleDraftIds.has(version.id),
        )}
        recommendations={message.recommendations}
        activityEvents={message.activityEvents}
        sources={message.sources}
        contextResourceManifest={message.contextResourceManifest}
        contextResourceSelections={message.contextResourceSelections}
        assistantName={assistantName}
        onOpenArtifact={(artifact) =>
          actionsRef.current.openArtifact(artifact)
        }
        onDeployAppDraft={(version) =>
          actionsRef.current.deployAppDraft(version)
        }
        onDiscardAppProposal={(version) =>
          actionsRef.current.discardAppProposal(version)
        }
        onIterateAppProposal={(version, feedback) =>
          actionsRef.current.iterateAppProposal(version, feedback)
        }
        onArtifactProposalAction={(artifact, decision) =>
          actionsRef.current.artifactProposalAction(artifact, decision)
        }
        onIterateArtifactProposal={(artifact, feedback) =>
          actionsRef.current.iterateArtifactProposal(artifact, feedback)
        }
        onRecommendationAction={(recommendation, status) =>
          actionsRef.current.recommendationAction(recommendation, status)
        }
        recommendationPendingId={recommendationPendingId}
        appDraftPendingId={appDraftPendingId}
        artifactProposalPendingId={artifactProposalPendingId}
        onRegenerate={
          showRegenerate
            ? () => actionsRef.current.regenerate()
            : undefined
        }
        onEdit={
          editable
            ? () =>
                actionsRef.current.edit({
                  requestId: crypto.randomUUID(),
                  messageId: message.id,
                  content: stripAttachmentNoteFromMessage(message.content),
                  attachmentCount:
                    message.artifacts?.filter(
                      (artifact) => artifact.source === "user-upload",
                    ).length ?? 0,
                  contextResourceReferences:
                    message.contextResourceReferences,
                  contextResourceManifest: message.contextResourceManifest,
                })
            : undefined
        }
      />
      {message.runId &&
      (message.canCancel || message.canRetry || message.canResume) ? (
        <RunControls
          runId={message.runId}
          canCancel={message.canCancel}
          canRetry={message.canRetry}
          canResume={message.canResume && isAdmin}
          pendingAction={runActionPendingId}
          onAction={(runId, action) =>
            actionsRef.current.runAction(runId, action)
          }
        />
      ) : null}
      {isAdmin && message.role === "assistant" && message.runId ? (
        <button
          type="button"
          aria-label="Inspect run"
          title="Inspect run"
          onClick={() => actionsRef.current.openRunInspector(message.runId!)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
        >
          <RunInspectorIcon />
        </button>
      ) : null}
    </div>
  );
}

export const ChatMessageRow = memo(
  ChatMessageRowComponent,
  areChatMessageRowPropsEqual,
);
ChatMessageRow.displayName = "ChatMessageRow";

function RunControls({
  runId,
  canCancel,
  canRetry,
  canResume,
  pendingAction,
  onAction,
}: {
  runId: string;
  canCancel?: boolean;
  canRetry?: boolean;
  canResume?: boolean;
  pendingAction?: string;
  onAction: (
    runId: string,
    action: "cancel" | "retry" | "resume",
  ) => void;
}) {
  const pending = pendingAction?.endsWith(`:${runId}`) ?? false;
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {canCancel ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction(runId, "cancel")}
          className="rounded-md border border-hairline bg-canvas px-2.5 py-1 font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pendingAction === `cancel:${runId}` ? "Canceling..." : "Cancel"}
        </button>
      ) : null}
      {canRetry ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction(runId, "retry")}
          className="rounded-md border border-hairline bg-canvas px-2.5 py-1 font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pendingAction === `retry:${runId}` ? "Retrying..." : "Retry"}
        </button>
      ) : null}
      {canResume ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction(runId, "resume")}
          className="rounded-md border border-hairline bg-canvas px-2.5 py-1 font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pendingAction === `resume:${runId}` ? "Resuming..." : "Resume"}
        </button>
      ) : null}
    </div>
  );
}

function RunInspectorIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.5h4M8.5 4.5h5M2.5 8h7M11.5 8h2M2.5 11.5h2M6.5 11.5h7" />
      <circle cx="7.5" cy="4.5" r="1" />
      <circle cx="10.5" cy="8" r="1" />
      <circle cx="5.5" cy="11.5" r="1" />
    </svg>
  );
}
