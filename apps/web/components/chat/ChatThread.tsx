import { ChatEmptyState } from "@/components/chat/ChatEmptyState";
import { MessageBubble } from "@/components/MessageBubble";
import { ThinkingOrb } from "@/components/ThinkingOrb";
import { ThreadLoadingSkeleton } from "@/components/ThreadLoadingSkeleton";
import type { ChatEditRequest } from "@/components/ChatInput";
import type { ChatTab } from "@/app/chat/chat-client-state";
import {
  latestAppDraftVersionIds,
  type AppDraftVersionSummary,
} from "@/lib/app-draft-versions";
import { stripAttachmentNoteFromMessage } from "@/lib/attachments";
import type {
  PersistedRecommendation,
  RecommendationStatus,
} from "@/lib/recommendations";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

const STICK_BOTTOM_THRESHOLD = 100;

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
  runActionPendingId?: string;
  stickToBottomRef: MutableRefObject<boolean>;
  onPickSuggestion: (suggestion: string) => void;
  onOpenIntegrations: () => void;
  onOpenArtifact: (artifact: WorkspaceArtifactSummary) => void;
  onDeployAppDraft: (version: AppDraftVersionSummary) => void;
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
  runActionPendingId,
  stickToBottomRef,
  onPickSuggestion,
  onOpenIntegrations,
  onOpenArtifact,
  onDeployAppDraft,
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
              <div key={message.id} className="flex flex-col gap-2">
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
                  livePhase={message.livePhase}
                  liveTokens={message.liveTokens}
                  toolCalls={message.toolCalls}
                  toolResults={message.toolResults}
                  artifacts={message.artifacts}
                  appDraftVersions={message.appDraftVersions?.filter((version) =>
                    latestAppDraftIds.has(version.id),
                  )}
                  recommendations={message.recommendations}
                  activityEvents={message.activityEvents}
                  sources={message.sources}
                  assistantName={assistantName}
                  onOpenArtifact={onOpenArtifact}
                  onDeployAppDraft={onDeployAppDraft}
                  onRecommendationAction={onRecommendationAction}
                  recommendationPendingId={recommendationPendingId}
                  appDraftPendingId={appDraftPendingId}
                  onRegenerate={
                    message.id === lastAssistantMessage?.id && canRegenerate
                      ? onRegenerate
                      : undefined
                  }
                  onEdit={
                    message.role === "user" &&
                    !busy &&
                    !activeHasPendingRun &&
                    (!message.hasAttachments ||
                      message.attachmentsReplayable === true) &&
                    message.persisted
                      ? () =>
                          onEdit({
                            requestId: crypto.randomUUID(),
                            messageId: message.id,
                            content: stripAttachmentNoteFromMessage(
                              message.content,
                            ),
                            attachmentCount:
                              message.artifacts?.filter(
                                (artifact) =>
                                  artifact.source === "user-upload",
                              ).length ?? 0,
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
                    onAction={onRunAction}
                  />
                ) : null}
                {isAdmin && message.role === "assistant" && message.runId ? (
                  <button
                    type="button"
                    aria-label="Inspect run"
                    title="Inspect run"
                    onClick={() => onOpenRunInspector(message.runId!)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
                  >
                    <RunInspectorIcon />
                  </button>
                ) : null}
              </div>
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
