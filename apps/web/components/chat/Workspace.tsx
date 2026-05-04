"use client";

import { ChatTab } from "@/components/chat/ChatTab";
import { TabBar } from "@/components/chat/TabBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import type { ModelOption } from "@/components/ModelSelector";
import { ComingSoon } from "@/components/ui/ComingSoon";
import type { ModelId } from "@ai-workspace/agent";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface WorkspaceProps {
  user: { displayName: string; email: string };
}

const NEW_TAB_PREFIX = "new:";

interface TabState {
  id: string;
  isNew: boolean;
  title: string;
}

interface ComingSoonState {
  feature: string;
  description?: string;
}

export function Workspace({ user }: WorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const isPopout = searchParams.get("popout") === "1";

  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<ModelId>("sonnet-4-6");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [comingSoon, setComingSoon] = useState<ComingSoonState | null>(null);

  // Load model registry once.
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json() as Promise<{ defaultModelId: ModelId; models: ModelOption[] }>)
      .then((data) => {
        setModels(data.models);
        setDefaultModelId(data.defaultModelId);
      })
      .catch(() => {
        // Non-fatal — tabs will show "Loading models…"
      });
  }, []);

  const tabs = useMemo<TabState[]>(() => {
    const raw = searchParams.get("tabs");
    if (!raw) return [];
    return raw
      .split(",")
      .filter(Boolean)
      .map((id) => ({
        id,
        isNew: id.startsWith(NEW_TAB_PREFIX),
        title: id.startsWith(NEW_TAB_PREFIX) ? "New chat" : titles[id] ?? "Loading…",
      }));
  }, [searchParams, titles]);

  const activeId = searchParams.get("active") ?? tabs[0]?.id;
  const openThreadIds = useMemo(
    () => tabs.filter((t) => !t.isNew).map((t) => t.id),
    [tabs],
  );

  const bumpRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const fetchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.isNew) continue;
      if (titles[t.id] || fetchedRef.current.has(t.id)) continue;
      fetchedRef.current.add(t.id);
      fetch(`/api/threads/${t.id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((data: { thread: { title: string | null } }) => {
          setTitles((prev) => ({
            ...prev,
            [t.id]: data.thread.title ?? "Untitled",
          }));
        })
        .catch(() => {
          setTitles((prev) => ({ ...prev, [t.id]: "Unavailable" }));
        });
    }
  }, [tabs, titles]);

  const updateUrl = useCallback(
    (nextTabIds: readonly string[], nextActive: string | undefined) => {
      const params = new URLSearchParams(searchParams.toString());
      if (nextTabIds.length === 0) {
        params.delete("tabs");
        params.delete("active");
      } else {
        params.set("tabs", nextTabIds.join(","));
        if (nextActive) params.set("active", nextActive);
        else params.delete("active");
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const openThread = useCallback(
    (threadId: string) => {
      // newTab vs same-tab is moot: opening an already-open thread just focuses
      // it; opening a new thread always appends a tab.
      const existing = tabs.find((t) => t.id === threadId);
      if (existing) {
        updateUrl(
          tabs.map((t) => t.id),
          threadId,
        );
        return;
      }
      const nextIds = [...tabs.map((t) => t.id), threadId];
      updateUrl(nextIds, threadId);
    },
    [tabs, updateUrl],
  );

  const newChat = useCallback(() => {
    const localId = `${NEW_TAB_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
    const nextIds = [...tabs.map((t) => t.id), localId];
    updateUrl(nextIds, localId);
  }, [tabs, updateUrl]);

  const selectTab = useCallback(
    (id: string) => {
      updateUrl(
        tabs.map((t) => t.id),
        id,
      );
    },
    [tabs, updateUrl],
  );

  const closeTab = useCallback(
    (id: string) => {
      const remaining = tabs.filter((t) => t.id !== id);
      const nextActive =
        activeId === id
          ? remaining[remaining.length - 1]?.id
          : activeId;
      if (remaining.length === 0) {
        // Always keep at least one tab open by spawning a fresh one.
        const localId = `${NEW_TAB_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
        updateUrl([localId], localId);
        return;
      }
      updateUrl(
        remaining.map((t) => t.id),
        nextActive,
      );
    },
    [tabs, activeId, updateUrl],
  );

  const popOut = useCallback(
    (id: string) => {
      // Open a window with just this tab in popout mode.
      const url = `${pathname}?tabs=${id}&active=${id}&popout=1`;
      window.open(url, `aihub-tab-${id}`, "width=900,height=700,noopener");
      // Close the tab in this window (the user has it in the new window now).
      closeTab(id);
    },
    [pathname, closeTab],
  );

  const handleThreadDeleted = useCallback(
    (id: string) => {
      // Remove any tabs pointing at the deleted thread.
      const remaining = tabs.filter((t) => t.id !== id);
      if (remaining.length !== tabs.length) {
        const nextActive =
          activeId === id
            ? remaining[remaining.length - 1]?.id
            : activeId;
        if (remaining.length === 0) {
          const localId = `${NEW_TAB_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
          updateUrl([localId], localId);
        } else {
          updateUrl(
            remaining.map((t) => t.id),
            nextActive,
          );
        }
      }
      bumpRefresh();
    },
    [tabs, activeId, updateUrl, bumpRefresh],
  );

  const swapNewTab = useCallback(
    (placeholderId: string, realId: string) => {
      const nextIds = tabs.map((t) => (t.id === placeholderId ? realId : t.id));
      const nextActive = activeId === placeholderId ? realId : activeId;
      updateUrl(nextIds, nextActive);
      bumpRefresh();
    },
    [tabs, activeId, updateUrl, bumpRefresh],
  );

  const handleComingSoon = useCallback((feature: string, description?: string) => {
    setComingSoon({ feature, description });
  }, []);

  // Bootstrap: if no tabs, open one fresh tab. Skip in popout mode (URL controls it).
  useEffect(() => {
    if (tabs.length === 0 && !isPopout) {
      newChat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------- Pop-out mode: render a single tab chrome-free --------
  if (isPopout) {
    const popTab = tabs[0];
    return (
      <div className="flex h-screen flex-col bg-white dark:bg-zinc-950">
        {popTab ? (
          <ChatTab
            threadId={popTab.isNew ? undefined : popTab.id}
            models={models}
            defaultModelId={defaultModelId}
            visible
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            No tab specified.
          </div>
        )}
      </div>
    );
  }

  const activeTitle = tabs.find((t) => t.id === activeId)?.title ?? "AI Hub";

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-zinc-950">
      <TopBar
        title="AI Hub"
        right={
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            {activeTitle}
          </span>
        }
        onSettings={() =>
          handleComingSoon(
            "Settings",
            "App settings (theme, default model, keyboard shortcuts) lands once we have something worth configuring.",
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          userName={user.displayName}
          userEmail={user.email}
          activeThreadId={
            activeId && !activeId.startsWith(NEW_TAB_PREFIX) ? activeId : undefined
          }
          openThreadIds={openThreadIds}
          onOpenThread={openThread}
          onNewChat={newChat}
          onComingSoon={handleComingSoon}
          onThreadDeleted={handleThreadDeleted}
          refreshKey={refreshKey}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onSelect={selectTab}
            onClose={closeTab}
            onNew={newChat}
            onPopOut={popOut}
          />
          <div className="min-h-0 flex-1">
            {tabs.map((t) => (
              <ChatTab
                key={t.id}
                threadId={t.isNew ? undefined : t.id}
                models={models}
                defaultModelId={defaultModelId}
                visible={t.id === activeId}
                onThreadCreated={(realId) => swapNewTab(t.id, realId)}
                onMessagePersisted={() => {
                  bumpRefresh();
                  if (!t.isNew) {
                    fetchedRef.current.delete(t.id);
                    setTitles((prev) => {
                      const next = { ...prev };
                      delete next[t.id];
                      return next;
                    });
                  }
                }}
              />
            ))}
          </div>
        </main>
      </div>

      <ComingSoon
        feature={comingSoon?.feature ?? null}
        description={comingSoon?.description}
        onClose={() => setComingSoon(null)}
      />
    </div>
  );
}
