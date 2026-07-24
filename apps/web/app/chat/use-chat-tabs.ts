import type { ModelOption } from "@/components/ModelSelector";
import type { ThreadSummary } from "@/components/Sidebar";
import {
  ClientApiError,
  fetchJson,
  throwApiError,
} from "@/lib/client-api";
import { sortThreadHistory } from "@/lib/thread-history";
import {
  makeFreshTab,
  mergeLoadedMessages,
  threadMessageToUiMessage,
  type ChatTab,
  type ThreadMessagesResponse,
  type UiMessage,
} from "./chat-client-state";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

interface UseChatTabsOptions {
  initialThreadId?: string;
  userId?: string;
  models: ModelOption[];
  defaultModelId: string;
  userDefaultModelId?: string;
  threads: ThreadSummary[];
  setThreads: Dispatch<SetStateAction<ThreadSummary[]>>;
}

function validString(
  value: string | undefined,
  knownValues: Set<string>,
  fallback: string,
): string {
  return value && knownValues.has(value) ? value : fallback;
}

export function useChatTabs({
  initialThreadId,
  userId,
  models,
  defaultModelId,
  userDefaultModelId,
  threads,
  setThreads,
}: UseChatTabsOptions) {
  const [tabs, setTabs] = useState<ChatTab[]>(() => [makeFreshTab()]);
  const [activeId, setActiveId] = useState(() => tabs[0]!.id);
  const loadingThreadsRef = useRef<Set<string>>(new Set());
  const initialThreadAppliedRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  useEffect(() => {
    if (models.length === 0) return;
    const validIds = new Set(models.map((model) => model.id));
    setTabs((previous) =>
      previous.map((tab) =>
        tab.modelId && validIds.has(tab.modelId)
          ? tab
          : { ...tab, modelId: defaultModelId },
      ),
    );
  }, [defaultModelId, models]);

  useEffect(() => {
    if (models.length === 0 || !userDefaultModelId) return;
    const validIds = new Set(models.map((model) => model.id));
    if (!validIds.has(userDefaultModelId)) return;
    setTabs((previous) =>
      previous.map((tab) =>
        !tab.threadId && tab.messages.length === 0
          ? { ...tab, modelId: userDefaultModelId }
          : tab,
      ),
    );
  }, [models, userDefaultModelId]);

  useEffect(() => {
    const titleByThreadId = new Map(
      threads.map((thread) => [
        thread.id,
        thread.title?.trim() || "Untitled",
      ]),
    );
    setTabs((previous) =>
      previous.map((tab) => {
        if (!tab.threadId) return tab;
        const title = titleByThreadId.get(tab.threadId);
        return title && title !== tab.title ? { ...tab, title } : tab;
      }),
    );
  }, [threads]);

  useEffect(() => {
    if (!initialThreadId || !userId || initialThreadAppliedRef.current) return;
    initialThreadAppliedRef.current = true;
    const thread = threads.find((candidate) => candidate.id === initialThreadId);
    const validIds = new Set(models.map((model) => model.id));
    const modelId = validString(
      thread?.defaultModelId,
      validIds,
      defaultModelId,
    );
    const tab: ChatTab = {
      id: crypto.randomUUID(),
      title: thread?.title?.trim() || `Thread ${initialThreadId.slice(0, 8)}`,
      threadId: initialThreadId,
      messages: [],
      modelId,
      busy: false,
      loaded: false,
    };
    setTabs([tab]);
    setActiveId(tab.id);
  }, [defaultModelId, initialThreadId, models, threads, userId]);

  useEffect(() => {
    if (tabs.length === 0 || tabs.some((tab) => tab.id === activeId)) return;
    const timeoutId = window.setTimeout(() => {
      setActiveId((current) =>
        tabs.some((tab) => tab.id === current) ? current : tabs[0]!.id,
      );
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [activeId, tabs]);

  useEffect(() => {
    if (!activeTab?.id || activeTab.loaded || !activeTab.threadId) return;
    if (loadingThreadsRef.current.has(activeTab.id)) return;
    const tabId = activeTab.id;
    const threadId = activeTab.threadId;
    loadingThreadsRef.current.add(tabId);
    let cancelled = false;

    fetchJson<ThreadMessagesResponse>(
      `/api/threads/${threadId}/messages`,
      undefined,
      "Could not load messages.",
    )
      .then((data) => {
        if (cancelled) return;
        const messages = data.messages.map(threadMessageToUiMessage);
        setTabs((previous) =>
          previous.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  messages: mergeLoadedMessages(messages, tab.messages),
                  loaded: true,
                }
              : tab,
          ),
        );
        stickToBottomRef.current = true;
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        if (
          (error instanceof ClientApiError && error.status === 404) ||
          /thread_not_found/i.test(message)
        ) {
          setTabs([makeFreshTab(defaultModelId)]);
          return;
        }
        setTabs((previous) =>
          previous.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  error: `failed to load messages: ${message}`,
                  loaded: true,
                }
              : tab,
          ),
        );
      })
      .finally(() => {
        loadingThreadsRef.current.delete(tabId);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab?.id, activeTab?.loaded, activeTab?.threadId, defaultModelId]);

  function patchTab(id: string, patch: Partial<ChatTab>) {
    setTabs((previous) =>
      previous.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    );
  }

  function patchTabMessages(
    id: string,
    update: (messages: UiMessage[]) => UiMessage[],
  ) {
    setTabs((previous) =>
      previous.map((tab) =>
        tab.id === id ? { ...tab, messages: update(tab.messages) } : tab,
      ),
    );
  }

  function freshTabModel(): string {
    if (
      userDefaultModelId &&
      models.some((model) => model.id === userDefaultModelId)
    ) {
      return userDefaultModelId;
    }
    return defaultModelId;
  }

  function newTab() {
    const tab = makeFreshTab(freshTabModel(), false);
    setTabs([tab]);
    setActiveId(tab.id);
  }

  function openThread(
    threadId: string,
    title: string,
    initialMessages: UiMessage[] = [],
  ) {
    const existing = activeTab?.threadId === threadId ? activeTab : undefined;
    if (existing) {
      if (initialMessages.length > 0) {
        setTabs((previous) =>
          previous.map((tab) =>
            tab.id === existing.id
              ? {
                  ...tab,
                  messages: mergeLoadedMessages(
                    tab.messages,
                    initialMessages,
                  ),
                }
              : tab,
          ),
        );
      }
      setActiveId(existing.id);
      return;
    }
    const thread = threads.find((candidate) => candidate.id === threadId);
    const validIds = new Set(models.map((model) => model.id));
    const modelId = validString(
      thread?.defaultModelId,
      validIds,
      defaultModelId,
    );
    const trimmed = title.trim();
    const tab: ChatTab = {
      id: crypto.randomUUID(),
      title: trimmed.length > 0 ? trimmed : "Untitled",
      threadId,
      messages: initialMessages,
      modelId,
      busy: false,
      loaded: initialMessages.length > 0,
    };
    setTabs([tab]);
    setActiveId(tab.id);
  }

  function changeModel(modelId: string) {
    if (activeTab) patchTab(activeTab.id, { modelId });
  }

  async function renameThread(threadId: string, title: string) {
    await fetchJson(
      `/api/threads/${threadId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      },
      "Could not rename the chat.",
    );
    setThreads((previous) =>
      previous.map((thread) =>
        thread.id === threadId ? { ...thread, title } : thread,
      ),
    );
  }

  async function deleteThread(threadId: string): Promise<boolean> {
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      await throwApiError(response, "Could not delete the chat.");
    }
    setThreads((previous) =>
      previous.filter((thread) => thread.id !== threadId),
    );
    if (activeTab?.threadId !== threadId) return false;
    const fresh = makeFreshTab(freshTabModel(), false);
    setTabs([fresh]);
    setActiveId(fresh.id);
    return true;
  }

  async function pinThread(threadId: string, pinned: boolean) {
    const data = await fetchJson<{
      thread: { id: string; pinned: boolean; updatedAt: string };
    }>(
      `/api/threads/${threadId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      },
      `Could not ${pinned ? "pin" : "unpin"} the chat.`,
    );
    setThreads((previous) =>
      sortThreadHistory(
        previous.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                pinned: data.thread.pinned,
                updatedAt: data.thread.updatedAt,
              }
            : thread,
        ),
      ),
    );
  }

  return {
    tabs,
    setTabs,
    activeId,
    activeTab,
    stickToBottomRef,
    patchTab,
    patchTabMessages,
    newTab,
    openThread,
    changeModel,
    renameThread,
    deleteThread,
    pinThread,
  };
}
