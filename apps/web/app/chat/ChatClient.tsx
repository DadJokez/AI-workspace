"use client";

import {
  ChatInput,
  type ChatEditRequest,
} from "@/components/ChatInput";
import { FeedbackReporter } from "@/components/FeedbackReporter";
import {
  useCommandPalette,
  useRegisterCommandPaletteActions,
} from "@/components/CommandPalette";
import {
  SettingsModal,
  type SettingsSection,
} from "@/components/SettingsModal";
import { WelcomeWizard } from "@/components/WelcomeWizard";
import { fetchJson } from "@/lib/client-api";
import type { ChatAttachment } from "@/lib/attachments";
import type { ChatModelOverride } from "@/lib/model-command";
import type { ActivatedSlashSkill } from "@/lib/skill-commands";
import {
  contextResourceSearchResultsFromManifest,
  type ContextResourceSearchResult,
} from "@/lib/context-shelf";
import { shouldShowTour } from "@/lib/tour";
import { Sidebar } from "@/components/Sidebar";
import { useHorizontalSwipe } from "@/components/useHorizontalSwipe";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type {
  ThreadBranchRequest,
  ThreadBranchResponse,
} from "@/lib/thread-branch-types";
import {
  formatArtifactReviewMessage,
  type ArtifactReviewSelection,
} from "@/lib/artifact-review-client";
import {
  deriveContributionStudio,
  type ContributionStudioScope,
} from "@/lib/contribution-studio";
import posthog from "posthog-js";
import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type RightPane,
  type UiMessage,
  type UserResponse,
} from "./chat-client-state";
import {
  buildFeedbackContext,
  downloadChatTranscript,
  downloadPersistedThreadTranscript,
} from "./chat-client-presentation";
import { useChatActions } from "./use-chat-actions";
import { useChatResources } from "./use-chat-resources";
import { useChatStream } from "./use-chat-stream";
import { useChatTabs } from "./use-chat-tabs";
import { useRunPolling } from "./use-run-polling";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { ChatPaneHost } from "@/components/chat/ChatPaneHost";
import { ChatThread } from "@/components/chat/ChatThread";
import { ChatTurnQueue } from "@/components/chat/ChatTurnQueue";
import { useChatTurnQueue } from "./use-chat-turn-queue";

interface ChatClientProps {
  initialThreadId?: string;
  initialOpen?: "settings" | "artifacts" | "studio" | "upload";
  initialSettingsSection?: "memory" | "integrations";
  initialMemoryId?: string;
  initialArtifactId?: string;
  initialReviewCommentId?: string;
}

export function ChatClient({
  initialThreadId,
  initialOpen,
  initialSettingsSection,
  initialMemoryId,
  initialArtifactId,
  initialReviewCommentId,
}: ChatClientProps) {
  const router = useRouter();
  const { openPalette } = useCommandPalette();
  const {
    models,
    modelsLoading,
    modelsError,
    defaultModelId,
    runtimeV2Enabled,
    liveTurnSteeringSupported,
    studioBrowserSupported,
    user,
    setUser,
    threads,
    setThreads,
    threadsLoading,
    threadsError,
    userDefaultModelId,
    connectedProviders,
    emptyStateSuggestions,
    slashSkills,
    unreadNotifications,
    setUnreadNotifications,
    refreshModels,
    refreshThreads,
    handleProfileUpdated,
    updateUserDefaultModel,
  } = useChatResources();
  const {
    setTabs,
    activeId,
    activeTab,
    stickToBottomRef,
    patchTab,
    patchTabMessages,
    newTab: resetTab,
    openThread: selectThread,
    changeModel,
    renameThread: handleRenameThread,
    deleteThread,
    pinThread: handlePinThread,
  } = useChatTabs({
    initialThreadId,
    userId: user?.id,
    models,
    defaultModelId,
    userDefaultModelId,
    threads,
    setThreads,
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection | null>(() =>
      initialOpen === "settings"
        ? (initialSettingsSection ?? "profile")
        : null,
    );
  const [settingsFocusId, setSettingsFocusId] = useState<string | undefined>(
    initialMemoryId,
  );
  const [rightPane, setRightPane] = useState<RightPane | null>(() =>
    initialOpen === "artifacts"
      ? { kind: "studio", tab: "files", scope: "workspace" }
      : initialOpen === "studio"
        ? { kind: "studio", scope: "thread" }
        : null,
  );
  const [uploadRequestId, setUploadRequestId] = useState(
    initialOpen === "upload" ? 1 : 0,
  );
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [branchPending, setBranchPending] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editRequest, setEditRequest] = useState<ChatEditRequest>();
  const [editingQueuedTurnId, setEditingQueuedTurnId] = useState<string | null>(
    null,
  );
  const patchTabRef = useRef(patchTab);
  const activeIdRef = useRef(activeId);
  const closeRightPane = useCallback(() => setRightPane(null), []);
  const openSidebarSwipe = useHorizontalSwipe({
    direction: "right",
    edge: "left",
    disabled: sidebarOpen || rightPane !== null,
    onSwipe: () => setSidebarOpen(true),
  });

  const composerDraftKey =
    user && activeTab
      ? `${user.id}:${activeTab.threadId ?? "new"}`
      : undefined;
  const inspectedRunId =
    rightPane?.kind === "inspector" ? rightPane.runId : null;
  const inspectedMessage = inspectedRunId
    ? activeTab?.messages.find((message) => message.runId === inspectedRunId)
    : undefined;

  useEffect(() => {
    patchTabRef.current = patchTab;
    activeIdRef.current = activeId;
  }, [activeId, patchTab]);

  useEffect(() => {
    if (user?.role !== "admin") return;
    const runId = new URLSearchParams(window.location.search).get("inspectRun");
    if (runId && /^[0-9a-f-]{36}$/i.test(runId)) {
      setRightPane({ kind: "inspector", runId });
    }
  }, [user?.role]);

  useEffect(() => {
    setEditRequest(undefined);
    setEditingQueuedTurnId(null);
  }, [activeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.has("connected")) {
      setSettingsSection("integrations");
    }
  }, []);

  useEffect(() => {
    if (!initialArtifactId) return;
    let cancelled = false;
    const errorTabId = activeIdRef.current;
    void fetchJson<{ artifact: WorkspaceArtifactSummary }>(
      `/api/workspace/artifacts/${encodeURIComponent(initialArtifactId)}`,
      undefined,
      "Could not open that artifact.",
    )
      .then(({ artifact }) => {
        if (cancelled) return;
        setRightPane({
          kind: "studio",
          tab: "preview",
          artifact,
          scope: artifact.threadId ? "thread" : "workspace",
          focusReviewCommentId: initialReviewCommentId,
        });
      })
      .catch(async () => {
        if (cancelled) return;
        let message = "Could not open that artifact.";
        if (initialReviewCommentId) {
          try {
            const response = await fetch(
              `/api/workspace/artifact-review-comments/${encodeURIComponent(initialReviewCommentId)}`,
              { cache: "no-store" },
            );
            if (response.status === 410) {
              const body = (await response.json()) as {
                artifact?: { filename?: string; versionNumber?: number };
              };
              const filename = body.artifact?.filename ?? "This artifact";
              const version = body.artifact?.versionNumber;
              message = `${filename}${version ? ` v${version}` : ""} was deleted. Its review history remains, but the source can no longer be opened.`;
            } else if (response.status === 404) {
              message =
                "This review link is no longer available, or you no longer have permission to open it.";
            }
          } catch {
            // Preserve the generic artifact error when the diagnostic lookup fails.
          }
        }
        if (cancelled) return;
        if (errorTabId) patchTabRef.current(errorTabId, { error: message });
        setRightPane({ kind: "studio", tab: "files", scope: "workspace" });
      });
    return () => {
      cancelled = true;
    };
  }, [initialArtifactId, initialReviewCommentId]);

  // Open settings via ⌘,/Ctrl,
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsSection("profile");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // First-run welcome tour (#136): show once per user, the first time the
  // profile loads with tour_completed_at unset. Finishing or skipping
  // persists completion; Settings can replay it any time.
  useEffect(() => {
    if (user && shouldShowTour(user)) {
      setWizardOpen(true);
    }
  }, [user]);

  const completeWizard = () => {
    setWizardOpen(false);
    if (user && user.tourCompletedAt === null) {
      setUser({ ...user, tourCompletedAt: new Date().toISOString() });
      void fetch("/api/user", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tourCompleted: true }),
      }).catch(() => {});
    }
  };

  const saveWizardStep = async (patch: { assistantName: string }) => {
    const body = await fetchJson<UserResponse>(
      "/api/user",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
      "Could not save your assistant name.",
    );
    setUser(body.user);
  };

  const { activeHasPendingRun } = useRunPolling({
    activeTab,
    setTabs,
    refreshThreads,
  });

  function newTab() {
    detachStreaming();
    resetTab();
    setRightPane(null);
  }

  function openThread(
    threadId: string,
    title: string,
    initialMessages: UiMessage[] = [],
  ) {
    setRightPane(null);
    if (activeTab?.threadId !== threadId) detachStreaming();
    selectThread(threadId, title, initialMessages);
  }

  function handleModelChange(id: string) {
    changeModel(id);
  }

  async function handleDeleteThread(threadId: string) {
    if (await deleteThread(threadId)) setRightPane(null);
  }

  function handleNavSelect(id: string) {
    if (id === "chat") {
      setRightPane(null);
    } else if (id === "settings") {
      setSettingsSection("profile");
      setRightPane(null);
    } else if (id === "workspace") {
      setRightPane({ kind: "studio", tab: "files", scope: "workspace" });
    } else if (id === "feedback") {
      posthog.capture("feedback_opened");
      setFeedbackOpen(true);
    } else if (id === "admin") {
      router.push("/admin");
    }
  }

  function openArtifactPreview(
    artifact: WorkspaceArtifactSummary,
    scope: ContributionStudioScope = "thread",
  ) {
    setRightPane({ kind: "studio", tab: "preview", artifact, scope });
  }

  function openPaletteArtifact(
    artifact: WorkspaceArtifactSummary,
    threadTitle?: string,
  ) {
    setSettingsSection(null);
    if (artifact.threadId && artifact.threadId !== activeTab?.threadId) {
      openThread(
        artifact.threadId,
        threadTitle?.trim() || artifact.title || "Artifact",
      );
    }
    openArtifactPreview(
      artifact,
      artifact.threadId ? "thread" : "workspace",
    );
  }

  function openRunInspector(runId: string) {
    setRightPane({ kind: "inspector", runId });
  }

  function handleDownloadTranscript() {
    if (!activeTab) return;
    if (!activeTab.threadId) {
      downloadChatTranscript(activeTab);
      posthog.capture("chat_transcript_downloaded");
      return;
    }
    const tabId = activeTab.id;
    void downloadPersistedThreadTranscript(activeTab)
      .then(() => posthog.capture("chat_transcript_downloaded"))
      .catch(() => {
        patchTab(tabId, {
          error: "Could not download the transcript. Please try again.",
        });
      });
  }

  const { detachStreaming, send, stopStreaming } = useChatStream({
    activeTab,
    defaultModelId,
    patchTab,
    patchTabMessages,
    refreshThreads,
    setRightPane,
    stickToBottomRef,
  });

  function addressArtifactReviewComments({
    artifact,
    comments,
  }: {
    artifact: WorkspaceArtifactSummary;
    comments: ArtifactReviewSelection[];
  }): Promise<boolean> {
    if (!activeTab?.threadId) {
      if (activeTab) {
        patchTab(activeTab.id, {
          error: "Open or create a chat before addressing review comments.",
        });
      }
      return Promise.resolve(false);
    }
    const message = formatArtifactReviewMessage({
      filename: artifact.filename,
      versionNumber: artifact.versionNumber,
      commentCount: comments.length,
    });
    return send(
      message,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { artifactId: artifact.id, comments },
    );
  }
  const queuedTurns = useChatTurnQueue({
    userId: user?.id,
    tabId: activeTab?.id,
    threadId: activeTab?.threadId,
  });
  const sendRef = useRef(send);
  const queueFlushRef = useRef<string | null>(null);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const currentRunActive = Boolean(activeTab?.busy || activeHasPendingRun);

  async function branchWork(request: ThreadBranchRequest) {
    if (!activeTab || branchPending) return;
    const sourceTabId = activeTab.id;
    if (currentRunActive) {
      patchTab(sourceTabId, {
        error: "Wait for the current response to finish before trying another approach.",
      });
      return;
    }
    setBranchPending(true);
    patchTab(sourceTabId, { error: undefined });
    try {
      const result = await fetchJson<ThreadBranchResponse>(
        "/api/threads/branch",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        "Could not create an alternative chat.",
      );
      setSettingsSection(null);
      openThread(
        result.thread.id,
        result.thread.title?.trim() || "Alternative approach",
      );
      void refreshThreads();
      posthog.capture("chat_branch_created", {
        source_type: request.sourceType,
        snapshot_messages: result.lineage.messageCount,
        pinned_resources: result.lineage.resources.length,
      });
    } catch (error) {
      patchTab(sourceTabId, {
        error:
          error instanceof Error
            ? error.message
            : "Could not create an alternative chat.",
      });
    } finally {
      setBranchPending(false);
    }
  }

  const queuedHead = queuedTurns.turns[0];
  const queuedScopeKey = queuedTurns.scopeKey;
  useEffect(() => {
    if (
      !queuedTurns.loaded ||
      currentRunActive ||
      !activeTab?.loaded ||
      !activeTab?.threadId ||
      !queuedScopeKey ||
      !queuedHead ||
      queuedHead.status !== "queued" ||
      editingQueuedTurnId !== null ||
      queueFlushRef.current !== null
    ) {
      return;
    }
    const turn = queuedHead;
    const scopeKey = queuedScopeKey;
    queueFlushRef.current = turn.id;
    queuedTurns.markSending(turn.id, scopeKey);
    void sendRef
      .current(
        turn.text,
        undefined,
        turn.activatedSkill,
        turn.modelOverride,
        undefined,
        undefined,
        turn.id,
        turn.contextResources,
      )
      .then((accepted) => {
        if (accepted) {
          queuedTurns.remove(turn.id, scopeKey);
        } else {
          queuedTurns.markFailed(
            turn.id,
            "This follow-up was not accepted. Try it again when the connection is ready.",
            scopeKey,
          );
        }
      })
      .catch(() => {
        queuedTurns.markFailed(
          turn.id,
          "This follow-up could not be sent. Check the connection and try again.",
          scopeKey,
        );
      })
      .finally(() => {
        if (queueFlushRef.current === turn.id) queueFlushRef.current = null;
      });
  }, [
    activeTab?.threadId,
    activeTab?.loaded,
    currentRunActive,
    editingQueuedTurnId,
    queuedHead,
    queuedScopeKey,
    queuedTurns,
  ]);

  function handleComposerSubmit(
    text: string,
    attachments?: ChatAttachment[],
    activatedSkill?: ActivatedSlashSkill,
    modelOverride?: ChatModelOverride,
    replaceMessageId?: string,
    contextResources?: ContextResourceSearchResult[],
  ): boolean {
    const queueMode = currentRunActive || queuedTurns.turns.length > 0;
    if (!queueMode) {
      void send(
        text,
        attachments,
        activatedSkill,
        modelOverride,
        replaceMessageId,
        undefined,
        undefined,
        contextResources,
      );
      return true;
    }
    if (replaceMessageId || attachments?.length) {
      patchTab(activeTab!.id, {
        error: replaceMessageId
          ? "Saved messages cannot be edited while another run is active."
          : "Files cannot be queued yet. Attach them after the current run finishes.",
      });
      return false;
    }
    queuedTurns.enqueue({
      text,
      activatedSkill,
      modelOverride,
      contextResources,
    });
    posthog.capture("chat_follow_up_queued", {
      queue_depth: queuedTurns.turns.length + 1,
      has_activated_skill: Boolean(activatedSkill),
      has_model_override: Boolean(modelOverride),
    });
    return true;
  }
  const {
    recommendationPendingId,
    appDraftPendingId,
    artifactProposalPendingId,
    runActionPendingId,
    handleRecommendationAction,
    handleAppDraftDeploy,
    handleAppProposalDiscard,
    handleAppProposalIteration,
    handleArtifactProposalAction,
    handleArtifactProposalIteration,
    runAction,
  } = useChatActions({
    activeTab,
    slashSkills,
    send,
    patchTab,
    setTabs,
    refreshThreads,
  });

  // Regenerate the last assistant answer: re-run the last user turn.
  function regenerate() {
    retry();
  }

  function retry() {
    if (!activeTab) return;
    const msgs = activeTab.messages;
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;
    const lastUserMessage = msgs[lastUserIdx]!;
    const lastUserText = lastUserMessage.content;
    const tabId = activeTab.id;
    patchTab(tabId, { error: undefined });
    if (!lastUserMessage.persisted) {
      patchTabMessages(tabId, (prev) => prev.slice(0, lastUserIdx));
    }
    void send(
      lastUserText,
      undefined,
      undefined,
      undefined,
      lastUserMessage.persisted ? lastUserMessage.id : undefined,
      undefined,
      undefined,
      lastUserMessage.contextResourceSelections ??
        contextResourceSearchResultsFromManifest(
          lastUserMessage.contextResourceReferences,
          lastUserMessage.contextResourceManifest,
        ),
    );
  }

  useRegisterCommandPaletteActions({
    currentThreadId: activeTab?.threadId,
    newChat: () => {
      setSettingsSection(null);
      newTab();
    },
    openArtifact: openPaletteArtifact,
    openArtifacts: () => {
      setSettingsSection(null);
      setRightPane({ kind: "studio", tab: "files", scope: "workspace" });
    },
    openSettings: (section = "profile", focusId) => {
      setSettingsFocusId(focusId);
      setSettingsSection(section);
      setRightPane(null);
    },
    openStudio: () => {
      setSettingsSection(null);
      setRightPane({ kind: "studio", scope: "thread" });
    },
    branchCurrentThread: () => {
      if (!activeTab?.threadId) return;
      void branchWork({
        sourceType: "thread",
        sourceThreadId: activeTab.threadId,
      });
    },
    openThread: (threadId, title) => {
      setSettingsSection(null);
      openThread(threadId, title);
    },
    uploadFile: () => {
      setSettingsSection(null);
      setRightPane(null);
      setUploadRequestId((current) => current + 1);
    },
  });

  if (!activeTab) return null;
  const inputDisabled =
    modelsLoading || modelsError !== undefined || models.length === 0;
  const queueMode = currentRunActive || queuedTurns.turns.length > 0;
  const feedbackContext = buildFeedbackContext(activeTab);
  const studioModel = deriveContributionStudio(activeTab.messages, {
    capabilities: { browser: studioBrowserSupported },
  });
  const studioOpen = rightPane?.kind === "studio";

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-ink">
      {/* App shell. SettingsModal marks this subtree `inert` while it is open
          (#648) so background controls leave the accessibility tree and cannot
          take focus or clicks; overlays below stay outside it. */}
      <div
        data-app-shell="true"
        className="flex h-full w-full min-w-0 overflow-hidden"
      >
        {!sidebarOpen && rightPane === null ? (
          <div
            aria-hidden="true"
            data-testid="sidebar-swipe-edge"
            onPointerDown={openSidebarSwipe}
            className="fixed bottom-24 left-0 top-12 z-20 w-6 touch-pan-y md:hidden"
          />
        ) : null}
        <Sidebar
          userName={user?.displayName}
          userEmail={user?.email}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onNewChat={newTab}
          onSearch={openPalette}
          autoCollapse={rightPane !== null}
          forceRail={studioOpen}
          threads={threads}
          threadsLoading={threadsLoading}
          threadsError={threadsError}
          activeThreadId={
            rightPane?.kind !== "studio" || rightPane.scope !== "workspace"
              ? activeTab.threadId
              : undefined
          }
          onOpenThread={openThread}
          activeNavId={
            rightPane?.kind === "studio" && rightPane.scope === "workspace"
              ? "workspace"
              : "chat"
          }
          onNavSelect={handleNavSelect}
          isAdmin={user?.role === "admin"}
          onSignOut={() => {
            posthog.reset();
            void signOut({ callbackUrl: "/login" });
          }}
          onRenameThread={handleRenameThread}
          onDeleteThread={handleDeleteThread}
          onPinThread={handlePinThread}
        />

        <main className="flex h-full min-w-0 flex-1 overflow-hidden">
          <section
            data-testid="chat-workspace-pane"
            className="flex h-full min-w-0 flex-1 flex-col"
          >
            <ChatHeader
              activeTab={activeTab}
              models={models}
              runtimeV2Enabled={runtimeV2Enabled}
              activeHasPendingRun={activeHasPendingRun}
              studioAvailable={studioModel.tabs.length > 0}
              studioOpen={studioOpen}
              studioWorking={studioModel.working || currentRunActive}
              unreadNotifications={unreadNotifications}
              branchPending={branchPending}
              onOpenMenu={() => setSidebarOpen(true)}
              onModelChange={handleModelChange}
              onToggleStudio={(open) =>
                setRightPane((current) => {
                  if (!open) return current?.kind === "studio" ? null : current;
                  return current?.kind === "studio"
                    ? current
                    : { kind: "studio", scope: "thread" };
                })
              }
              onToggleNotifications={() =>
                setRightPane((current) =>
                  current?.kind === "notifications"
                    ? null
                    : { kind: "notifications" },
                )
              }
              onDownload={handleDownloadTranscript}
              onBranchThread={() =>
                void branchWork({
                  sourceType: "thread",
                  sourceThreadId: activeTab.threadId!,
                })
              }
              onStop={stopStreaming}
            />

          <ChatThread
            activeTab={activeTab}
            activeHasPendingRun={activeHasPendingRun}
            displayName={user?.displayName}
            assistantName={user?.assistantName}
            isAdmin={user?.role === "admin"}
            connectedProviders={connectedProviders}
            suggestions={emptyStateSuggestions}
            recommendationPendingId={recommendationPendingId}
            appDraftPendingId={appDraftPendingId}
            artifactProposalPendingId={artifactProposalPendingId}
            runActionPendingId={runActionPendingId}
            branchPending={branchPending || currentRunActive}
            stickToBottomRef={stickToBottomRef}
            onPickSuggestion={(suggestion) => void send(suggestion)}
            onOpenIntegrations={() => setSettingsSection("integrations")}
            onOpenArtifact={openArtifactPreview}
            onOpenBrowserEvidence={
              studioBrowserSupported
                ? (messageId, sourceNumber) =>
                    setRightPane({
                      kind: "studio",
                      tab: "browser",
                      scope: "thread",
                      browserTarget: {
                        kind: "evidence",
                        messageId,
                        sourceNumber,
                      },
                    })
                : undefined
            }
            onDeployAppDraft={(version) => void handleAppDraftDeploy(version)}
            onDiscardAppProposal={(version) =>
              void handleAppProposalDiscard(version)
            }
            onIterateAppProposal={(version, feedback) =>
              void handleAppProposalIteration(version, feedback)
            }
            onArtifactProposalAction={(artifact, decision) =>
              void handleArtifactProposalAction(artifact, decision)
            }
            onIterateArtifactProposal={(artifact, feedback) =>
              void handleArtifactProposalIteration(artifact, feedback)
            }
            onRecommendationAction={(recommendation, status) =>
              void handleRecommendationAction(recommendation, status)
            }
            onRunAction={(runId, action) => void runAction(runId, action)}
            onOpenRunInspector={openRunInspector}
            onBranchMessage={(sourceMessageId) =>
              void branchWork({
                sourceType: "message",
                sourceThreadId: activeTab.threadId!,
                sourceMessageId,
              })
            }
            onBranchAppVersion={(version) =>
              void branchWork({
                sourceType: "app_version",
                ...(activeTab.threadId
                  ? { sourceThreadId: activeTab.threadId }
                  : {}),
                artifactId: version.artifactId,
                appVersionId: version.id,
              })
            }
            onBranchProposal={(artifact) =>
              void branchWork({
                sourceType: "proposal",
                ...(activeTab.threadId
                  ? { sourceThreadId: activeTab.threadId }
                  : {}),
                artifactId: artifact.id,
              })
            }
            onOpenBranchSource={openThread}
            onRegenerate={regenerate}
            onEdit={setEditRequest}
            onRetry={retry}
          />

          <div
            data-tour="chat-input"
            className="kb-safe-bottom border-t border-hairline bg-canvas px-3 pt-3 sm:px-6 sm:pt-4"
          >
            <div className="mx-auto max-w-3xl">
              <ChatTurnQueue
                turns={queuedTurns.turns}
                liveTurnSteeringSupported={liveTurnSteeringSupported}
                onUpdate={queuedTurns.update}
                onRemove={queuedTurns.remove}
                onMove={queuedTurns.move}
                onApplyNow={queuedTurns.applyNext}
                onRetry={queuedTurns.retry}
                onEditingChange={setEditingQueuedTurnId}
              />
              {modelsError ? (
                <div
                  role="alert"
                  data-testid="models-load-error"
                  className="mb-3 flex items-center justify-between gap-3 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-sm text-danger"
                >
                  <span>{modelsError}</span>
                  <button
                    type="button"
                    onClick={() => void refreshModels()}
                    disabled={modelsLoading}
                    className="shrink-0 rounded-sm border border-danger/30 px-2.5 py-1 text-xs font-medium hover:bg-danger/10 disabled:cursor-wait disabled:opacity-60"
                  >
                    {modelsLoading ? "Retrying..." : "Retry"}
                  </button>
                </div>
              ) : null}
              <ChatInput
                key={activeTab.id}
                onSubmit={handleComposerSubmit}
                disabled={inputDisabled}
                queueMode={queueMode}
                skills={slashSkills}
                draftKey={composerDraftKey}
                threadId={activeTab.threadId}
                restoreDraft={activeTab.restoreDraft !== false}
                editRequest={editRequest}
                onEditComplete={() => setEditRequest(undefined)}
                uploadRequestId={uploadRequestId}
                placeholder={
                  modelsLoading
                    ? "Starting Comparative..."
                    : modelsError
                      ? "Comparative is unavailable"
                      : queueMode
                        ? "Add a follow-up for the current run"
                        : "Ask anything (Shift+Enter for newline)"
                }
              />
            </div>
          </div>
          </section>

          <ChatPaneHost
            rightPane={rightPane}
            isAdmin={user?.role === "admin"}
            messages={activeTab.messages}
            threadId={activeTab.threadId}
            studioBrowserSupported={studioBrowserSupported}
            inspectedMessage={inspectedMessage}
            onClose={closeRightPane}
            onOpenArtifact={openArtifactPreview}
            onOpenRunInspector={openRunInspector}
            onBranchArtifact={(artifact) =>
              void branchWork({
                sourceType: "artifact",
                ...(activeTab.threadId
                  ? { sourceThreadId: activeTab.threadId }
                  : {}),
                artifactId: artifact.id,
              })
            }
            branchPending={branchPending || currentRunActive}
            onAddressArtifactReview={addressArtifactReviewComments}
            onOpenThread={openThread}
            onUnreadChange={setUnreadNotifications}
          />
        </main>
      </div>

      {settingsSection ? (
        <SettingsModal
          userEmail={user?.email}
          displayName={user?.displayName ?? ""}
          customInstructions={user?.customInstructions ?? null}
          initialSection={settingsSection}
          memoryFocusId={settingsFocusId}
          onProfileUpdated={handleProfileUpdated}
          models={models}
          defaultModelId={defaultModelId}
          userDefaultModelId={userDefaultModelId}
          onUserDefaultModelChange={updateUserDefaultModel}
          runtimeV2Enabled={runtimeV2Enabled}
          onClose={() => {
            setSettingsSection(null);
            setSettingsFocusId(undefined);
          }}
          onReplayTour={() => setWizardOpen(true)}
        />
      ) : null}

      <WelcomeWizard
        open={wizardOpen}
        initialAssistantName={user?.assistantName ?? null}
        startAtTour={user?.tourCompletedAt != null}
        onSave={saveWizardStep}
        onComplete={completeWizard}
      />
      <FeedbackReporter
        open={feedbackOpen}
        context={feedbackContext}
        onClose={() => setFeedbackOpen(false)}
      />
    </div>
  );
}
