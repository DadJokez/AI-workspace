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
import { shouldShowTour } from "@/lib/tour";
import { Sidebar } from "@/components/Sidebar";
import { useHorizontalSwipe } from "@/components/useHorizontalSwipe";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import posthog from "posthog-js";
import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  type RightPane,
  type UiMessage,
  type UserResponse,
} from "./chat-client-state";
import {
  buildFeedbackContext,
  downloadChatTranscript,
} from "./chat-client-presentation";
import { useChatActions } from "./use-chat-actions";
import { useChatResources } from "./use-chat-resources";
import { useChatStream } from "./use-chat-stream";
import { useChatTabs } from "./use-chat-tabs";
import { useRunPolling } from "./use-run-polling";
import { ChatHeader } from "@/components/chat/ChatHeader";
import { ChatPaneHost } from "@/components/chat/ChatPaneHost";
import { ChatThread } from "@/components/chat/ChatThread";

interface ChatClientProps {
  initialThreadId?: string;
  initialOpen?: "settings" | "artifacts";
}

export function ChatClient({ initialThreadId, initialOpen }: ChatClientProps) {
  const router = useRouter();
  const { openPalette } = useCommandPalette();
  const {
    models,
    defaultModelId,
    runtimeV2Enabled,
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
      initialOpen === "settings" ? "profile" : null,
    );
  const [rightPane, setRightPane] = useState<RightPane | null>(() =>
    initialOpen === "artifacts" ? { kind: "workspace" } : null,
  );
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editRequest, setEditRequest] = useState<ChatEditRequest>();
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
    if (user?.role !== "admin") return;
    const runId = new URLSearchParams(window.location.search).get("inspectRun");
    if (runId && /^[0-9a-f-]{36}$/i.test(runId)) {
      setRightPane({ kind: "inspector", runId });
    }
  }, [user?.role]);

  useEffect(() => {
    setEditRequest(undefined);
  }, [activeId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.has("connected")) {
      setSettingsSection("integrations");
    }
  }, []);

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
    stopStreaming();
    resetTab();
    setRightPane(null);
  }

  function openThread(
    threadId: string,
    title: string,
    initialMessages: UiMessage[] = [],
  ) {
    setRightPane(null);
    if (activeTab?.threadId !== threadId) stopStreaming();
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
      setRightPane({ kind: "workspace" });
    } else if (id === "feedback") {
      posthog.capture("feedback_opened");
      setFeedbackOpen(true);
    } else if (id === "admin") {
      router.push("/admin");
    }
  }

  function openArtifactPreview(artifact: WorkspaceArtifactSummary) {
    setRightPane({ kind: "artifact", artifact });
  }

  function openRunInspector(runId: string) {
    setRightPane({ kind: "inspector", runId });
  }

  function handleDownloadTranscript() {
    if (!activeTab) return;
    posthog.capture("chat_transcript_downloaded");
    downloadChatTranscript(activeTab);
  }

  const { send, stopStreaming } = useChatStream({
    activeTab,
    defaultModelId,
    patchTab,
    patchTabMessages,
    refreshThreads,
    setRightPane,
    stickToBottomRef,
  });
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
    );
  }

  useRegisterCommandPaletteActions({
    newChat: () => {
      setSettingsSection(null);
      newTab();
    },
    openArtifacts: () => {
      setSettingsSection(null);
      setRightPane({ kind: "workspace" });
    },
    openSettings: () => {
      setSettingsSection("profile");
      setRightPane(null);
    },
    openThread: (threadId, title) => {
      setSettingsSection(null);
      openThread(threadId, title);
    },
  });

  if (!activeTab) return null;
  const { busy } = activeTab;
  const inputDisabled = busy || activeHasPendingRun || models.length === 0;
  const feedbackContext = buildFeedbackContext(activeTab);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-ink">
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
        threads={threads}
        threadsLoading={threadsLoading}
        threadsError={threadsError}
        activeThreadId={
          rightPane?.kind !== "workspace" ? activeTab.threadId : undefined
        }
        onOpenThread={openThread}
        activeNavId={rightPane?.kind === "workspace" ? "workspace" : "chat"}
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
            unreadNotifications={unreadNotifications}
            onOpenMenu={() => setSidebarOpen(true)}
            onModelChange={handleModelChange}
            onToggleNotifications={() =>
              setRightPane((current) =>
                current?.kind === "notifications"
                  ? null
                  : { kind: "notifications" },
              )
            }
            onDownload={handleDownloadTranscript}
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
          stickToBottomRef={stickToBottomRef}
          onPickSuggestion={(suggestion) => void send(suggestion)}
          onOpenIntegrations={() => setSettingsSection("integrations")}
          onOpenArtifact={openArtifactPreview}
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
          onRegenerate={regenerate}
          onEdit={setEditRequest}
          onRetry={retry}
        />

        <div
          data-tour="chat-input"
          className="kb-safe-bottom border-t border-hairline bg-canvas px-3 pt-3 sm:px-6 sm:pt-4"
        >
          <div className="mx-auto max-w-3xl">
            <ChatInput
              key={activeTab?.id ?? "composer-loading"}
              onSubmit={send}
              disabled={inputDisabled}
              skills={slashSkills}
              draftKey={composerDraftKey}
              restoreDraft={activeTab.restoreDraft !== false}
              editRequest={editRequest}
              onEditComplete={() => setEditRequest(undefined)}
              placeholder={
                models.length === 0
                  ? "Loading models…"
                  : busy
                    ? "Generating…"
                    : activeHasPendingRun
                      ? "Run in progress…"
                    : "Ask anything (Shift+Enter for newline)"
              }
            />
          </div>
        </div>
        </section>

        <ChatPaneHost
          rightPane={rightPane}
          isAdmin={user?.role === "admin"}
          inspectedMessage={inspectedMessage}
          onClose={closeRightPane}
          onOpenArtifact={openArtifactPreview}
          onOpenThread={openThread}
          onUnreadChange={setUnreadNotifications}
        />
      </main>

      {settingsSection ? (
        <SettingsModal
          userEmail={user?.email}
          displayName={user?.displayName ?? ""}
          customInstructions={user?.customInstructions ?? null}
          initialSection={settingsSection}
          onProfileUpdated={handleProfileUpdated}
          models={models}
          defaultModelId={defaultModelId}
          userDefaultModelId={userDefaultModelId}
          onUserDefaultModelChange={updateUserDefaultModel}
          runtimeV2Enabled={runtimeV2Enabled}
          onClose={() => setSettingsSection(null)}
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
