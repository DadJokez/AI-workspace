import { ChatEmptyState } from "@/components/chat/ChatEmptyState";
import {
  ChatMessageRow,
  type ChatMessageRowActions,
} from "@/components/chat/ChatMessageRow";
import { ThinkingOrb } from "@/components/ThinkingOrb";
import { ThreadLoadingSkeleton } from "@/components/ThreadLoadingSkeleton";
import type { ChatEditRequest } from "@/components/ChatInput";
import type { ChatTab } from "@/app/chat/chat-client-state";
import {
  latestAppDraftVersionIds,
  type AppDraftVersionSummary,
} from "@/lib/app-draft-versions";
import type {
  PersistedRecommendation,
  RecommendationStatus,
} from "@/lib/recommendations";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type { OutputProposalDecision } from "@/lib/output-proposals";
import { useEffect, useRef, useState, type MutableRefObject } from "react";

const STICK_BOTTOM_THRESHOLD = 100;
const OFFSCREEN_VIRTUALIZATION_THRESHOLD = 24;

interface ChatThreadProps {
  activeTab: ChatTab;
  activeHasPendingRun: boolean;
  displayName?: string;
  assistantName?: string | null;
  isAdmin: boolean;
  connectedProviders: string[] | null;
  suggestions: string[] | null;
  recommendationPendingId?: string;
  appDraftPendingId?: string;
  artifactProposalPendingId?: string;
  runActionPendingId?: string;
  stickToBottomRef: MutableRefObject<boolean>;
  onPickSuggestion: (suggestion: string) => void;
  onOpenIntegrations: () => void;
  onOpenArtifact: (artifact: WorkspaceArtifactSummary) => void;
  onDeployAppDraft: (version: AppDraftVersionSummary) => void;
  onDiscardAppProposal: (version: AppDraftVersionSummary) => void;
  onIterateAppProposal: (
    version: AppDraftVersionSummary,
    feedback: string,
  ) => void;
  onArtifactProposalAction: (
    artifact: WorkspaceArtifactSummary,
    decision: OutputProposalDecision,
  ) => void;
  onIterateArtifactProposal: (
    artifact: WorkspaceArtifactSummary,
    feedback: string,
  ) => void;
  onRecommendationAction: (
    recommendation: PersistedRecommendation,
    status: RecommendationStatus,
  ) => void;
  onRunAction: (
    runId: string,
    action: "cancel" | "retry" | "resume",
  ) => void;
  onOpenRunInspector: (runId: string) => void;
  onRegenerate: () => void;
  onEdit: (request: ChatEditRequest) => void;
  onRetry: () => void;
}

export function ChatThread({
  activeTab,
  activeHasPendingRun,
  displayName,
  assistantName,
  isAdmin,
  connectedProviders,
  suggestions,
  recommendationPendingId,
  appDraftPendingId,
  artifactProposalPendingId,
  runActionPendingId,
  stickToBottomRef,
  onPickSuggestion,
  onOpenIntegrations,
  onOpenArtifact,
  onDeployAppDraft,
  onDiscardAppProposal,
  onIterateAppProposal,
  onArtifactProposalAction,
  onIterateArtifactProposal,
  onRecommendationAction,
  onRunAction,
  onOpenRunInspector,
  onRegenerate,
  onEdit,
  onRetry,
}: ChatThreadProps) {
  const [messageClock, setMessageClock] = useState(() => Date.now());
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const jumpScrollInProgressRef = useRef(false);
  const jumpScrollResetRef = useRef<number | undefined>(undefined);
  const messageActionsRef = useRef<ChatMessageRowActions>({
    openArtifact: onOpenArtifact,
    deployAppDraft: onDeployAppDraft,
    discardAppProposal: onDiscardAppProposal,
    iterateAppProposal: onIterateAppProposal,
    artifactProposalAction: onArtifactProposalAction,
    iterateArtifactProposal: onIterateArtifactProposal,
    recommendationAction: onRecommendationAction,
    runAction: onRunAction,
    openRunInspector: onOpenRunInspector,
    regenerate: onRegenerate,
    edit: onEdit,
  });
  const { busy, error, messages } = activeTab;
  const latestAppDraftIds = latestAppDraftVersionIds(
    messages.flatMap((message) => message.appDraftVersions ?? []),
  );
  const lastAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const canRegenerate =
    !busy &&
    !activeHasPendingRun &&
    messages.some((message) => message.role === "assistant" && !message.pending);
  const deferOffscreenRendering =
    messages.length >= OFFSCREEN_VIRTUALIZATION_THRESHOLD;

  useEffect(() => {
    messageActionsRef.current = {
      openArtifact: onOpenArtifact,
      deployAppDraft: onDeployAppDraft,
      discardAppProposal: onDiscardAppProposal,
      iterateAppProposal: onIterateAppProposal,
      artifactProposalAction: onArtifactProposalAction,
      iterateArtifactProposal: onIterateArtifactProposal,
      recommendationAction: onRecommendationAction,
      runAction: onRunAction,
      openRunInspector: onOpenRunInspector,
      regenerate: onRegenerate,
      edit: onEdit,
    };
  }, [
    onDeployAppDraft,
    onDiscardAppProposal,
    onIterateAppProposal,
    onArtifactProposalAction,
    onIterateArtifactProposal,
    onEdit,
    onOpenArtifact,
    onOpenRunInspector,
    onRecommendationAction,
    onRegenerate,
    onRunAction,
  ]);

  useEffect(() => {
    const intervalId = window.setInterval(
      () => setMessageClock(Date.now()),
      60_000,
    );
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(
    () => () => {
      if (jumpScrollResetRef.current !== undefined) {
        window.clearTimeout(jumpScrollResetRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (stickToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
      setShowJumpToLatest(false);
      return;
    }
    setShowJumpToLatest(true);
  }, [messages, stickToBottomRef]);

  useEffect(() => {
    stickToBottomRef.current = true;
    jumpScrollInProgressRef.current = false;
    setShowJumpToLatest(false);
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activeTab.id, stickToBottomRef]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.clientHeight - element.scrollTop;
    const isStuck = distance < STICK_BOTTOM_THRESHOLD;
    if (jumpScrollInProgressRef.current) {
      stickToBottomRef.current = true;
      setShowJumpToLatest(false);
      if (isStuck) {
        jumpScrollInProgressRef.current = false;
        if (jumpScrollResetRef.current !== undefined) {
          window.clearTimeout(jumpScrollResetRef.current);
          jumpScrollResetRef.current = undefined;
        }
      }
      return;
    }
    stickToBottomRef.current = isStuck;
    if (isStuck) {
      setShowJumpToLatest(false);
    } else if (busy || activeHasPendingRun) {
      setShowJumpToLatest(true);
    }
  }

  function scrollToLatest() {
    const element = scrollRef.current;
    if (!element) return;
    jumpScrollInProgressRef.current = true;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    if (jumpScrollResetRef.current !== undefined) {
      window.clearTimeout(jumpScrollResetRef.current);
    }
    jumpScrollResetRef.current = window.setTimeout(() => {
      jumpScrollInProgressRef.current = false;
      jumpScrollResetRef.current = undefined;
      const distance =
        element.scrollHeight - element.clientHeight - element.scrollTop;
      const isStuck = distance < STICK_BOTTOM_THRESHOLD;
      stickToBottomRef.current = isStuck;
      setShowJumpToLatest(!isStuck && Boolean(busy || activeHasPendingRun));
    }, 1_000);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="chat-scroll-region"
        onScroll={handleScroll}
        className="h-full overflow-x-hidden overflow-y-auto"
      >
        <div
          data-density="messages"
          className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8"
        >
          {!activeTab.loaded ? (
            <ThreadLoadingSkeleton />
          ) : messages.length === 0 ? (
            <ChatEmptyState
              onPick={onPickSuggestion}
              onOpenIntegrations={onOpenIntegrations}
              displayName={displayName}
              connectedProviders={connectedProviders}
              suggestions={suggestions}
            />
          ) : (
            messages.map((message) => (
              <ChatMessageRow
                key={message.id}
                message={message}
                messageClock={messageClock}
                assistantName={assistantName}
                isAdmin={isAdmin}
                visibleAppDraftVersionIds={(message.appDraftVersions ?? [])
                  .filter((version) => latestAppDraftIds.has(version.id))
                  .map((version) => version.id)
                  .join("\u0000")}
                showRegenerate={
                  message.id === lastAssistantMessage?.id && canRegenerate
                }
                editable={
                  message.role === "user" &&
                  !busy &&
                  !activeHasPendingRun &&
                  (!message.hasAttachments ||
                    message.attachmentsReplayable === true) &&
                  Boolean(message.persisted)
                }
                recommendationPendingId={recommendationPendingId}
                appDraftPendingId={appDraftPendingId}
                artifactProposalPendingId={artifactProposalPendingId}
                runActionPendingId={runActionPendingId}
                deferOffscreenRendering={deferOffscreenRendering}
                actionsRef={messageActionsRef}
              />
            ))
          )}
          {messages.length > 0 ? (
            <ThreadOrb messages={messages} />
          ) : null}
          {error ? (
            <div className="flex flex-col gap-2 rounded-md border border-hairline bg-subtle px-3 py-2 text-sm text-ink sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-2xs font-medium uppercase tracking-wide text-muted">
                  Error
                </span>
                <span className="break-words [overflow-wrap:anywhere]">
                  {error}
                </span>
              </div>
              <button
                type="button"
                onClick={onRetry}
                disabled={busy || activeHasPendingRun}
                className="self-start rounded-md border border-hairline bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:bg-canvas/60 disabled:opacity-50 sm:self-auto"
              >
                Try again
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <span
        data-testid="jump-to-latest-status"
        aria-live="polite"
        className="sr-only"
      >
        {showJumpToLatest ? "New content below" : ""}
      </span>
      {showJumpToLatest ? (
        <button
          type="button"
          onClick={scrollToLatest}
          className="absolute bottom-3 left-1/2 z-10 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 text-xs font-medium text-ink shadow-md hover:bg-subtle"
        >
          <svg
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 3v9M4.5 8.5 8 12l3.5-3.5" />
          </svg>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

function ThreadOrb({ messages }: { messages: ChatTab["messages"] }) {
  const active = messages.find(
    (message) => message.role === "assistant" && message.pending,
  );
  const working = Boolean(active);
  const length = active?.content.length ?? 0;
  return (
    <div className="flex">
      <ThinkingOrb
        state={!working ? "idle" : length === 0 ? "thinking" : "responding"}
        energy={length}
        size={28}
        stroke={13}
        className={working ? "text-ink" : "text-muted"}
      />
    </div>
  );
}
