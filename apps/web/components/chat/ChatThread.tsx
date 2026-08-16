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
import type {
  ThreadAlternativeLink,
  ThreadBranchLineage,
} from "@/lib/thread-branch-types";
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
  toolApprovalPendingRunId?: string;
  branchPending?: boolean;
  stickToBottomRef: MutableRefObject<boolean>;
  onPickSuggestion: (suggestion: string) => void;
  onOpenIntegrations: () => void;
  onOpenArtifact: (artifact: WorkspaceArtifactSummary) => void;
  onOpenBrowserEvidence?: (messageId: string, sourceNumber: number) => void;
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
  onToolApprovalDecision: (
    runId: string,
    approvalIds: string[],
    decision: "approve" | "deny",
  ) => void;
  onOpenRunInspector: (runId: string) => void;
  onBranchMessage: (messageId: string) => void;
  onBranchAppVersion: (version: AppDraftVersionSummary) => void;
  onBranchProposal: (artifact: WorkspaceArtifactSummary) => void;
  onOpenBranchSource: (threadId: string, title: string) => void;
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
  toolApprovalPendingRunId,
  branchPending,
  stickToBottomRef,
  onPickSuggestion,
  onOpenIntegrations,
  onOpenArtifact,
  onOpenBrowserEvidence,
  onDeployAppDraft,
  onDiscardAppProposal,
  onIterateAppProposal,
  onArtifactProposalAction,
  onIterateArtifactProposal,
  onRecommendationAction,
  onRunAction,
  onToolApprovalDecision,
  onOpenRunInspector,
  onBranchMessage,
  onBranchAppVersion,
  onBranchProposal,
  onOpenBranchSource,
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
    openBrowserEvidence: onOpenBrowserEvidence,
    deployAppDraft: onDeployAppDraft,
    discardAppProposal: onDiscardAppProposal,
    iterateAppProposal: onIterateAppProposal,
    artifactProposalAction: onArtifactProposalAction,
    iterateArtifactProposal: onIterateArtifactProposal,
    recommendationAction: onRecommendationAction,
    runAction: onRunAction,
    toolApprovalDecision: onToolApprovalDecision,
    openRunInspector: onOpenRunInspector,
    branchMessage: onBranchMessage,
    branchAppVersion: onBranchAppVersion,
    branchProposal: onBranchProposal,
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
    !lastAssistantMessage?.branchSnapshot &&
    messages.some((message) => message.role === "assistant" && !message.pending);
  const deferOffscreenRendering =
    messages.length >= OFFSCREEN_VIRTUALIZATION_THRESHOLD;

  useEffect(() => {
    messageActionsRef.current = {
      openArtifact: onOpenArtifact,
      openBrowserEvidence: onOpenBrowserEvidence,
      deployAppDraft: onDeployAppDraft,
      discardAppProposal: onDiscardAppProposal,
      iterateAppProposal: onIterateAppProposal,
      artifactProposalAction: onArtifactProposalAction,
      iterateArtifactProposal: onIterateArtifactProposal,
      recommendationAction: onRecommendationAction,
      runAction: onRunAction,
      toolApprovalDecision: onToolApprovalDecision,
      openRunInspector: onOpenRunInspector,
      branchMessage: onBranchMessage,
      branchAppVersion: onBranchAppVersion,
      branchProposal: onBranchProposal,
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
    onOpenBrowserEvidence,
    onBranchAppVersion,
    onBranchMessage,
    onBranchProposal,
    onOpenRunInspector,
    onRecommendationAction,
    onRegenerate,
    onRunAction,
    onToolApprovalDecision,
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
          ) : null}
          {activeTab.loaded && activeTab.lineage ? (
            <BranchLineageBanner
              lineage={activeTab.lineage}
              onOpenSource={onOpenBranchSource}
            />
          ) : null}
          {activeTab.loaded && activeTab.alternatives?.length ? (
            <ThreadAlternatives
              alternatives={activeTab.alternatives}
              onOpen={onOpenBranchSource}
            />
          ) : null}
          {activeTab.loaded && messages.length === 0 ? (
            <ChatEmptyState
              onPick={onPickSuggestion}
              onOpenIntegrations={onOpenIntegrations}
              displayName={displayName}
              connectedProviders={connectedProviders}
              suggestions={suggestions}
            />
          ) : activeTab.loaded ? (
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
                  !message.branchSnapshot &&
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
                toolApprovalPendingRunId={toolApprovalPendingRunId}
                branchPending={branchPending}
                deferOffscreenRendering={deferOffscreenRendering}
                actionsRef={messageActionsRef}
              />
            ))
          ) : null}
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

function BranchLineageBanner({
  lineage,
  onOpenSource,
}: {
  lineage: ThreadBranchLineage;
  onOpenSource: (threadId: string, title: string) => void;
}) {
  const unavailableResources = lineage.resources.filter(
    (resource) => resource.status === "unavailable",
  ).length;
  const detail = [
    branchSourceLabel(lineage.sourceType),
    `${lineage.messageCount} ${lineage.messageCount === 1 ? "message" : "messages"}`,
    lineage.resources.length > 0
      ? `${lineage.resources.length} ${lineage.resources.length === 1 ? "file" : "files"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside
      data-testid="branch-lineage-banner"
      className="border-l-2 border-info/60 pl-3 text-xs text-muted"
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <BranchLineageIcon />
        <span>Alternative from</span>
        {lineage.parentThreadId ? (
          <button
            type="button"
            onClick={() =>
              onOpenSource(lineage.parentThreadId!, lineage.sourceTitle)
            }
            className="max-w-full truncate font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
          >
            {lineage.sourceTitle}
          </button>
        ) : (
          <span className="font-medium text-ink">{lineage.sourceTitle}</span>
        )}
        <span aria-hidden="true">·</span>
        <span>{detail}</span>
      </div>
      {unavailableResources > 0 ? (
        <p className="mt-1 text-danger">
          {unavailableResources} pinned {unavailableResources === 1 ? "file is" : "files are"} unavailable.
        </p>
      ) : null}
    </aside>
  );
}

function ThreadAlternatives({
  alternatives,
  onOpen,
}: {
  alternatives: ThreadAlternativeLink[];
  onOpen: (threadId: string, title: string) => void;
}) {
  return (
    <aside
      data-testid="thread-alternatives"
      className="border-l-2 border-info/35 pl-3 text-xs text-muted"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <BranchLineageIcon />
        <span>
          {alternatives.length}{" "}
          {alternatives.length === 1 ? "alternative" : "alternatives"}
        </span>
        {alternatives.map((alternative) => (
          <button
            key={alternative.threadId}
            type="button"
            onClick={() => onOpen(alternative.threadId, alternative.title)}
            className="max-w-52 truncate font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
          >
            {alternative.title}
          </button>
        ))}
      </div>
    </aside>
  );
}

function branchSourceLabel(sourceType: ThreadBranchLineage["sourceType"]) {
  if (sourceType === "message") return "Message snapshot";
  if (sourceType === "thread") return "Chat snapshot";
  if (sourceType === "app_version") return "App version";
  if (sourceType === "proposal") return "Proposal";
  return "File";
}

function BranchLineageIcon() {
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
      className="shrink-0"
    >
      <circle cx="4" cy="3" r="1.25" />
      <circle cx="12" cy="6" r="1.25" />
      <circle cx="4" cy="13" r="1.25" />
      <path d="M4 4.25v5.5M5.25 6h5.5M4 9.75c0-2.1 1.35-3.75 3.35-3.75" />
    </svg>
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
