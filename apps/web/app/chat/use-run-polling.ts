import {
  shouldReloadThread,
  type RunStatusResponse,
  type RunStatusSnapshot,
} from "@/lib/run-poll";
import {
  BACKGROUND_COMPLETION_TITLE,
  mergeLoadedMessages,
  RUN_POLL_INTERVAL_MS,
  threadMessageToUiMessage,
  type ChatTab,
  type ThreadMessagesResponse,
  type UiMessage,
} from "./chat-client-state";
import {
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

interface UseRunPollingOptions {
  activeTab: ChatTab | undefined;
  setTabs: Dispatch<SetStateAction<ChatTab[]>>;
  refreshThreads: () => void | Promise<void>;
}

export function reconcilePendingRunMessages(
  loadedMessages: UiMessage[],
  currentMessages: UiMessage[],
): UiMessage[] {
  const merged = mergeLoadedMessages(loadedMessages, currentMessages);
  if (loadedMessages.some((message) => message.pending)) return merged;
  return merged.filter(
    (message) => !(message.pending && message.id.startsWith("run:")),
  );
}

export function useRunPolling({
  activeTab,
  setTabs,
  refreshThreads,
}: UseRunPollingOptions): { activeHasPendingRun: boolean } {
  const pendingRunRef = useRef<{
    tabId: string;
    runId: string;
    completedAssistantIds: string[];
  } | null>(null);

  const activePendingRunMessageId =
    activeTab?.messages.find(
      (message) => message.pending && message.id.startsWith("run:"),
    )?.id ?? null;
  const activePendingRunId =
    activePendingRunMessageId?.slice("run:".length) ?? null;
  const completedAssistantSignature =
    activeTab?.messages
      .filter((message) => message.role === "assistant" && !message.pending)
      .map((message) => message.id)
      .join("\u0000") ?? "";
  const activeTabId = activeTab?.id;

  useEffect(() => {
    const completedAssistantIds = completedAssistantSignature
      ? completedAssistantSignature.split("\u0000")
      : [];
    const previous = pendingRunRef.current;
    const current =
      activeTabId && activePendingRunMessageId
        ? {
            tabId: activeTabId,
            runId: activePendingRunMessageId,
            completedAssistantIds,
          }
        : null;
    pendingRunRef.current = current;
    const terminalResultVisible = previous
      ? completedAssistantIds.some(
          (id) =>
            id === previous.runId ||
            !previous.completedAssistantIds.includes(id),
        )
      : false;

    if (
      !previous ||
      current ||
      previous.tabId !== activeTabId ||
      !terminalResultVisible ||
      !document.hidden
    ) {
      return;
    }

    const previousTitle = document.title;
    let restored = false;
    document.title = BACKGROUND_COMPLETION_TITLE;

    function restoreTitle() {
      if (restored) return;
      restored = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", restoreTitle);
      if (document.title === BACKGROUND_COMPLETION_TITLE) {
        document.title = previousTitle;
      }
    }

    function handleVisibilityChange() {
      if (!document.hidden) restoreTitle();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", restoreTitle);
    return restoreTitle;
  }, [
    activeTabId,
    activePendingRunMessageId,
    completedAssistantSignature,
  ]);

  const refreshThreadsRef = useRef(refreshThreads);
  useEffect(() => {
    refreshThreadsRef.current = refreshThreads;
  });

  useEffect(() => {
    if (!activeTab?.threadId || !activePendingRunId) return;
    const tabId = activeTab.id;
    const threadId = activeTab.threadId;
    const runId = activePendingRunId;
    let cancelled = false;
    let cursor: RunStatusSnapshot | null = null;

    async function refreshPendingRun(): Promise<boolean> {
      try {
        const response = await fetch(`/api/threads/${threadId}/messages`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as ThreadMessagesResponse;
        if (cancelled) return false;
        const messages = data.messages.map(threadMessageToUiMessage);
        const hasLoadedPending = messages.some((message) => message.pending);
        setTabs((previous) =>
          previous.map((tab) => {
            if (tab.id !== tabId) return tab;
            return {
              ...tab,
              messages: reconcilePendingRunMessages(messages, tab.messages),
              loaded: true,
            };
          }),
        );
        if (!hasLoadedPending) void refreshThreadsRef.current();
        return true;
      } catch (error) {
        if (!cancelled) {
          console.error("failed to refresh pending run", error);
        }
        return false;
      }
    }

    async function pollRunStatus() {
      try {
        const response = await fetch(`/api/runs/${runId}/status`);
        if (cancelled) return;
        if (!response.ok) {
          void refreshPendingRun();
          return;
        }
        const data = (await response.json()) as RunStatusResponse;
        const next: RunStatusSnapshot = {
          status: data.run.status,
          latestEventSequence: data.run.latestEventSequence,
        };
        if (shouldReloadThread(cursor, next)) {
          const reloaded = await refreshPendingRun();
          if (!reloaded) return;
        }
        cursor = next;
      } catch (error) {
        if (!cancelled) {
          console.error("failed to poll pending run status", error);
        }
      }
    }

    void refreshPendingRun();
    const interval = window.setInterval(
      pollRunStatus,
      RUN_POLL_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activePendingRunId, activeTab?.id, activeTab?.threadId, setTabs]);

  return { activeHasPendingRun: activePendingRunMessageId !== null };
}
