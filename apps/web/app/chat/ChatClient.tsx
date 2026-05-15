"use client";

import { ChatInput } from "@/components/ChatInput";
import { MessageBubble } from "@/components/MessageBubble";
import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { SearchPanel } from "@/components/SearchPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Sidebar, type ThreadSummary } from "@/components/Sidebar";
import { ToolsPanel } from "@/components/ToolsPanel";
import { ThemeToggle } from "@/components/ThemeToggle";
import { readSseStream } from "@/lib/sse";
import { signOut } from "next-auth/react";
import { useEffect, useRef, useState } from "react";

// Model ids are now whatever Cursor's SDK reports back from /api/models —
// the union of "the 3 we have local metadata for" plus any others Cursor
// supports (GPT, Gemini, additional Claude variants). We treat them as
// opaque strings; the runtime layer is the source of truth on what's valid.
const FALLBACK_DEFAULT_MODEL_ID = "claude-sonnet-4-6";

type View = "chat" | "settings" | "search" | "tools";

const DEFAULT_MODEL_PREFIX = "ai-workspace-default-model:";

interface UiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId?: string;
  pending?: boolean;
  /** Live activity label shown while pending and no text has streamed yet
   *  (e.g. "Thinking…", "Calling github_list_repos…"). */
  status?: string;
}

interface ChatTab {
  id: string;
  title: string;
  threadId?: string;
  messages: UiMessage[];
  modelId?: string;
  busy: boolean;
  error?: string;
  /** True once messages have been loaded (or for fresh empty tabs). */
  loaded: boolean;
}

interface ChatStreamEvent {
  type:
    | "meta"
    | "text-delta"
    | "tool-call"
    | "tool-result"
    | "usage"
    | "error"
    | "done"
    | "persisted";
  [k: string]: unknown;
}

interface ModelsResponse {
  defaultModelId: string;
  models: ModelOption[];
}

interface UserResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: "admin" | "user";
    customInstructions: string | null;
  };
}

interface ThreadsResponse {
  threads: ThreadSummary[];
}

interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  modelId: string | null;
  runtime: "cursor" | "bedrock" | string | null;
  createdAt: string;
}

interface ThreadMessagesResponse {
  messages: ThreadMessage[];
}

const THREADS_LIMIT = 50;
const PERSISTED_TAB_LIMIT = 10;
const TAB_STORAGE_PREFIX = "ai-workspace-tabs:";

interface PersistedTab {
  threadId: string;
  title: string;
  modelId?: string;
}

interface PersistedSession {
  tabs: PersistedTab[];
  activeIdx: number;
}

function makeFreshTab(modelId?: string): ChatTab {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    threadId: undefined,
    messages: [],
    modelId,
    busy: false,
    loaded: true,
  };
}

function tabFromPersisted(p: PersistedTab, modelId: string): ChatTab {
  const trimmed = p.title?.trim();
  return {
    id: crypto.randomUUID(),
    title: trimmed && trimmed.length > 0 ? trimmed : "Untitled",
    threadId: p.threadId,
    messages: [],
    modelId,
    busy: false,
    loaded: false,
  };
}

function readSession(userId: string): PersistedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${TAB_STORAGE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(userId: string, session: PersistedSession): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      `${TAB_STORAGE_PREFIX}${userId}`,
      JSON.stringify(session),
    );
  } catch {
    /* quota / disabled — ignore */
  }
}

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 32) return trimmed;
  return trimmed.slice(0, 32).trimEnd() + "…";
}

/** Render an MCP tool name as a compact label for status text.
 *  Examples: "github_list_repos" → "github_list_repos",
 *  "mcp__github__list_repos" → "github · list_repos". Truncates very long
 *  names so the indicator stays one line. */
function formatToolName(raw: string): string {
  const m = /^mcp__([^_]+)__(.+)$/.exec(raw);
  const pretty = m ? `${m[1]} · ${m[2]}` : raw;
  return pretty.length > 48 ? pretty.slice(0, 47) + "…" : pretty;
}

const STICK_BOTTOM_THRESHOLD = 100;

export function ChatClient() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModelId, setDefaultModelId] =
    useState<string>(FALLBACK_DEFAULT_MODEL_ID);
  const [tabs, setTabs] = useState<ChatTab[]>(() => [makeFreshTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);
  const [user, setUser] = useState<UserResponse["user"] | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | undefined>();

  const [bootstrapped, setBootstrapped] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [userDefaultModelId, setUserDefaultModelId] = useState<
    string | undefined
  >();

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const loadingThreadsRef = useRef<Set<string>>(new Set());

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  function validatestring(
    id: string | undefined,
    knownIds: Set<string>,
    fallback: string,
  ): string {
    return id && knownIds.has(id) ? (id as string) : fallback;
  }

  async function refreshThreads() {
    try {
      const r = await fetch(`/api/threads?limit=${THREADS_LIMIT}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as ThreadsResponse;
      setThreads(data.threads);
      setThreadsError(undefined);
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : String(err));
    } finally {
      setThreadsLoading(false);
    }
  }

  // Bootstrap: fetch models + threads in parallel. Tabs are restored separately
  // from localStorage once /api/me resolves; we no longer auto-open recent
  // threads as tabs.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/models")
        .then((r) => (r.ok ? (r.json() as Promise<ModelsResponse>) : null))
        .catch(() => null),
      fetch(`/api/threads?limit=${THREADS_LIMIT}`)
        .then((r) =>
          r.ok
            ? (r.json() as Promise<ThreadsResponse>)
            : Promise.reject(new Error(`HTTP ${r.status}`)),
        )
        .catch((err) => err as Error),
    ]).then(([modelsData, threadsResult]) => {
      if (cancelled) return;

      if (modelsData) {
        setModels(modelsData.models);
        setDefaultModelId(modelsData.defaultModelId);
      }

      setThreadsLoading(false);
      if (threadsResult instanceof Error) {
        setThreadsError(threadsResult.message);
      } else {
        setThreads(threadsResult?.threads ?? []);
        setThreadsError(undefined);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/user")
      .then(async (r) => {
        // Middleware redirects unauthenticated users to /login before this
        // page mounts, so a 401 here means the session expired between
        // mount and this fetch. Bounce them to /login so they re-auth.
        if (r.status === 401) {
          window.location.assign("/login");
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as UserResponse;
      })
      .then((data) => {
        if (cancelled || !data?.user) return;
        setUser(data.user);
      })
      .catch((err) => {
        if (cancelled) return;
        // Surface the failure rather than silently dropping it. The user
        // chip simply stays empty until /api/user succeeds — useful when
        // debugging an auth/DB outage.
        console.error("failed to load /api/user", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Default-model preference is per-user but stored in localStorage rather
  // than the DB — it's a UI affordance, not a profile field.
  useEffect(() => {
    if (!user?.id || typeof window === "undefined") return;
    try {
      const dm = localStorage.getItem(`${DEFAULT_MODEL_PREFIX}${user.id}`);
      if (dm) setUserDefaultModelId(dm as string);
    } catch {
      /* ignore */
    }
  }, [user?.id]);

  // Open settings via ⌘,/Ctrl,
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setView("settings");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function handleProfileUpdated(next: {
    displayName: string;
    customInstructions: string | null;
  }) {
    setUser((prev) => (prev ? { ...prev, ...next } : prev));
  }

  function updateUserDefaultModel(id: string) {
    if (!user?.id || typeof window === "undefined") return;
    try {
      localStorage.setItem(`${DEFAULT_MODEL_PREFIX}${user.id}`, id);
    } catch {
      /* ignore */
    }
    setUserDefaultModelId(id);
  }

  // Validate every tab's modelId against the loaded model registry.
  // Runs whenever the registry changes; idempotent for already-valid tabs.
  useEffect(() => {
    if (models.length === 0) return;
    const validIds = new Set(models.map((m) => m.id));
    setTabs((prev) =>
      prev.map((t) =>
        t.modelId && validIds.has(t.modelId)
          ? t
          : { ...t, modelId: defaultModelId },
      ),
    );
  }, [models, defaultModelId]);

  // Restore tabs from localStorage once we know who the user is.
  // Runs at most once per session (gated by `bootstrapped`).
  useEffect(() => {
    if (!user?.id || bootstrapped) return;
    const session = readSession(user.id);
    if (session && session.tabs.length > 0) {
      const fallback = defaultModelId;
      const validIds = new Set(models.map((m) => m.id));
      const restored = session.tabs
        .slice(0, PERSISTED_TAB_LIMIT)
        .map((p) =>
          tabFromPersisted(p, validatestring(p.modelId, validIds, fallback)),
        );
      setTabs(restored);
      const idx = Math.max(
        0,
        Math.min(session.activeIdx ?? 0, restored.length - 1),
      );
      setActiveId(restored[idx]!.id);
    }
    setBootstrapped(true);
  }, [user?.id, bootstrapped, models, defaultModelId]);

  // Persist session whenever tabs / activeId change. Only after bootstrap, so
  // we don't clobber stored state with the initial empty-tab placeholder.
  useEffect(() => {
    if (!bootstrapped || !user?.id) return;
    const persistedTabs: PersistedTab[] = tabs
      .filter((t): t is ChatTab & { threadId: string } => !!t.threadId)
      .slice(0, PERSISTED_TAB_LIMIT)
      .map((t) => ({
        threadId: t.threadId,
        title: t.title,
        modelId: t.modelId,
      }));

    let activeIdx = 0;
    const activeWithThread = tabs.find((t) => t.id === activeId);
    if (activeWithThread?.threadId) {
      const i = persistedTabs.findIndex(
        (p) => p.threadId === activeWithThread.threadId,
      );
      if (i >= 0) activeIdx = i;
    }

    writeSession(user.id, { tabs: persistedTabs, activeIdx });
  }, [tabs, activeId, bootstrapped, user?.id]);

  // Keep activeId pointing at a real tab. If the active tab is removed (e.g.
  // a stale thread is dropped after a 404), fall back to the first tab.
  useEffect(() => {
    if (tabs.length === 0) return;
    if (!tabs.some((t) => t.id === activeId)) {
      setActiveId(tabs[0]!.id);
    }
  }, [tabs, activeId]);

  // Lazy-load messages for the active tab when it becomes active.
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab || tab.loaded || !tab.threadId) return;
    if (loadingThreadsRef.current.has(tab.id)) return;
    loadingThreadsRef.current.add(tab.id);
    let cancelled = false;
    const tabId = tab.id;
    const threadId = tab.threadId;
    fetch(`/api/threads/${threadId}/messages`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<ThreadMessagesResponse>)
          : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data) => {
        if (cancelled) return;
        const msgs: UiMessage[] = data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          modelId: m.modelId ?? undefined,
        }));
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, messages: msgs, loaded: true } : t,
          ),
        );
        // Reset stick-to-bottom on initial load so we land at the latest message.
        stickToBottomRef.current = true;
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        const isMissing = /HTTP 404|thread_not_found/i.test(message);
        if (isMissing) {
          // Stale persisted tab — silently drop it. If that leaves no tabs,
          // open a fresh one. The activeId-validity effect picks a neighbor.
          setTabs((prev) => {
            const next = prev.filter((t) => t.id !== tabId);
            return next.length > 0 ? next : [makeFreshTab(defaultModelId)];
          });
          return;
        }
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? { ...t, error: `failed to load messages: ${message}` }
              : t,
          ),
        );
      })
      .finally(() => {
        loadingThreadsRef.current.delete(tabId);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, tabs]);

  // Auto-scroll: only if user is at (or near) the bottom.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeTab?.messages]);

  // Tab switch: re-stick to bottom and jump there.
  useEffect(() => {
    stickToBottomRef.current = true;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeId]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    stickToBottomRef.current = distance < STICK_BOTTOM_THRESHOLD;
  }

  function patchTab(id: string, patch: Partial<ChatTab>) {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }

  function patchTabMessages(
    id: string,
    fn: (msgs: UiMessage[]) => UiMessage[],
  ) {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, messages: fn(t.messages) } : t)),
    );
  }

  function freshTabModel(): string {
    if (userDefaultModelId && models.some((m) => m.id === userDefaultModelId)) {
      return userDefaultModelId;
    }
    return defaultModelId;
  }

  function newTab() {
    const t = makeFreshTab(freshTabModel());
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
    setView("chat");
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const fresh = makeFreshTab(defaultModelId);
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) {
        const neighbor = next[Math.max(0, idx - 1)] ?? next[0]!;
        setActiveId(neighbor.id);
      }
      return next;
    });
  }

  function openThread(threadId: string, title: string) {
    setView("chat");
    const existing = tabs.find((t) => t.threadId === threadId);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const thread = threads.find((t) => t.id === threadId);
    const validIds = new Set(models.map((m) => m.id));
    const modelId = validatestring(
      thread?.defaultModelId,
      validIds,
      defaultModelId,
    );
    const trimmed = title.trim();
    const tab: ChatTab = {
      id: crypto.randomUUID(),
      title: trimmed.length > 0 ? trimmed : "Untitled",
      threadId,
      messages: [],
      modelId,
      busy: false,
      loaded: false,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }

  function selectTab(tabId: string) {
    setActiveId(tabId);
    setView("chat");
  }

  function handleModelChange(id: string) {
    if (!activeTab) return;
    patchTab(activeTab.id, { modelId: id });
  }

  async function handleRenameThread(threadId: string, title: string) {
    const res = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, title } : t)),
    );
    setTabs((prev) =>
      prev.map((t) => (t.threadId === threadId ? { ...t, title } : t)),
    );
  }

  async function handleDeleteThread(threadId: string) {
    const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status}`);
    }
    setThreads((prev) => prev.filter((t) => t.id !== threadId));
    setTabs((prev) => {
      const next = prev.filter((t) => t.threadId !== threadId);
      if (next.length === 0) {
        const fresh = makeFreshTab(defaultModelId);
        setActiveId(fresh.id);
        return [fresh];
      }
      return next;
    });
  }

  function handleNavSelect(id: string) {
    if (id === "chat") setView("chat");
    else if (id === "settings") setView("settings");
    else if (id === "search") setView("search");
    else if (id === "tools") setView("tools");
    else if (id === "admin") {
      // Admin lives at its own route, not as a chat-level view.
      window.location.assign("/admin");
    }
  }

  async function send(text: string) {
    if (!activeTab || activeTab.busy) return;
    const tabId = activeTab.id;
    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const modelId = activeTab.modelId ?? defaultModelId;

    patchTab(tabId, {
      busy: true,
      error: undefined,
      title:
        activeTab.messages.length === 0
          ? deriveTitle(text)
          : activeTab.title,
    });
    patchTabMessages(tabId, (prev) => [
      ...prev,
      { id: userMsgId, role: "user", content: text },
      {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        pending: true,
        status: "Thinking…",
      },
    ]);

    // New message from the user — re-stick to bottom.
    stickToBottomRef.current = true;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          threadId: activeTab.threadId,
          modelId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }

      let assistantText = "";
      let assistantModel: string | undefined;

      for await (const ev of readSseStream<ChatStreamEvent>(res)) {
        if (ev.type === "meta") {
          if (typeof ev.threadId === "string") {
            patchTab(tabId, { threadId: ev.threadId });
          }
          if (typeof ev.modelId === "string") assistantModel = ev.modelId;
        } else if (ev.type === "text-delta" && typeof ev.delta === "string") {
          assistantText += ev.delta;
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: assistantText,
                    pending: true,
                    status: undefined,
                    modelId: assistantModel,
                  }
                : m,
            ),
          );
        } else if (ev.type === "tool-call") {
          const call = ev.call as { name?: unknown } | undefined;
          const name =
            call && typeof call.name === "string" ? call.name : undefined;
          const status = name
            ? `Calling ${formatToolName(name)}…`
            : "Calling tool…";
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, status } : m,
            ),
          );
        } else if (ev.type === "tool-result") {
          // Tool finished. If no text has streamed yet, fall back to a
          // generic "Working…" so the indicator doesn't blink back to the
          // initial "Thinking…" between chained tool calls.
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              m.id === assistantMsgId && m.content.length === 0
                ? { ...m, status: "Working…" }
                : m,
            ),
          );
        } else if (ev.type === "error" && typeof ev.message === "string") {
          throw new Error(ev.message);
        } else if (ev.type === "done") {
          // wait for `persisted`
        } else if (ev.type === "persisted") {
          patchTabMessages(tabId, (prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    pending: false,
                    status: undefined,
                    modelId: assistantModel,
                  }
                : m,
            ),
          );
        }
      }

      patchTabMessages(tabId, (prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, pending: false, status: undefined }
            : m,
        ),
      );

      // Sidebar history may now have a new or moved-up entry.
      void refreshThreads();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchTab(tabId, { error: message });
      patchTabMessages(tabId, (prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, pending: false, status: undefined }
            : m,
        ),
      );
    } finally {
      patchTab(tabId, { busy: false });
    }
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
    const lastUserText = msgs[lastUserIdx]!.content;
    const tabId = activeTab.id;
    patchTab(tabId, { error: undefined });
    patchTabMessages(tabId, (prev) => prev.slice(0, lastUserIdx));
    void send(lastUserText);
  }

  if (!activeTab) return null;
  const { busy, error, messages } = activeTab;
  const inputDisabled = busy || models.length === 0;
  const isChatView = view === "chat";

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas text-ink">
      <Sidebar
        userName={user?.displayName}
        userEmail={user?.email}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewChat={newTab}
        threads={threads}
        threadsLoading={threadsLoading}
        threadsError={threadsError}
        activeThreadId={isChatView ? activeTab.threadId : undefined}
        onOpenThread={openThread}
        activeNavId={view}
        onNavSelect={handleNavSelect}
        isAdmin={user?.role === "admin"}
        onSignOut={() => signOut({ callbackUrl: "/login" })}
        onRenameThread={handleRenameThread}
        onDeleteThread={handleDeleteThread}
      />

      <main className="flex h-full min-w-0 flex-1 flex-col">
        {view === "settings" ? (
          <SettingsPanel
            userEmail={user?.email}
            displayName={user?.displayName ?? ""}
            customInstructions={user?.customInstructions ?? null}
            onProfileUpdated={handleProfileUpdated}
            models={models}
            defaultModelId={defaultModelId}
            userDefaultModelId={userDefaultModelId}
            onUserDefaultModelChange={updateUserDefaultModel}
            onClose={() => setView("chat")}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        ) : view === "search" ? (
          <SearchPanel
            threads={threads}
            threadsLoading={threadsLoading}
            onOpenThread={openThread}
            onClose={() => setView("chat")}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        ) : view === "tools" ? (
          <ToolsPanel
            onClose={() => setView("chat")}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        ) : (
          <>
        <header className="flex h-11 shrink-0 items-end justify-between border-b border-hairline bg-canvas">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="flex h-11 w-11 shrink-0 items-center justify-center self-center text-muted hover:bg-subtle hover:text-ink md:hidden"
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>
          <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2">
            {tabs.map((t) => {
              const active = t.id === activeId;
              return (
                <div
                  key={t.id}
                  className={`group relative flex h-9 max-w-[180px] shrink-0 items-center gap-1.5 px-3 text-[13px] ${
                    active
                      ? "text-ink"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectTab(t.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                  >
                    {t.busy ? (
                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" />
                    ) : null}
                    <span className="truncate">{t.title}</span>
                  </button>
                  {tabs.length > 1 ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                      aria-label="Close tab"
                      className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-subtle hover:text-ink md:h-4 md:w-4 md:opacity-0 md:group-hover:opacity-100"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="10"
                        height="10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      >
                        <path d="m4 4 8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  ) : null}
                  <span
                    aria-hidden
                    className={`absolute inset-x-2 bottom-0 h-px ${
                      active ? "bg-ink" : "bg-transparent"
                    }`}
                  />
                </div>
              );
            })}
            <button
              type="button"
              onClick={newTab}
              aria-label="New tab"
              className="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink md:h-7 md:w-7"
            >
              <svg
                viewBox="0 0 16 16"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              >
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1 self-center px-2 sm:gap-1.5 sm:px-3 sm:self-end sm:pb-1">
            {models.length > 0 && activeTab.modelId ? (
              <ModelSelector
                value={activeTab.modelId}
                onChange={handleModelChange}
                options={models}
                disabled={busy}
              />
            ) : null}
            <ThemeToggle />
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-x-hidden overflow-y-auto"
        >
          <div
            data-density="messages"
            className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8"
          >
            {messages.length === 0 ? (
              <EmptyState onPick={send} />
            ) : (
              messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  role={m.role}
                  content={m.content}
                  modelId={m.modelId}
                  pending={m.pending}
                  status={m.status}
                />
              ))
            )}
            {error ? (
              <div className="flex flex-col gap-2 rounded-md border border-hairline bg-subtle px-3 py-2 text-sm text-ink sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    Error
                  </span>
                  <span className="break-words [overflow-wrap:anywhere]">
                    {error}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={retry}
                  disabled={busy}
                  className="self-start rounded-md border border-hairline bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:bg-canvas/60 disabled:opacity-50 sm:self-auto"
                >
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="kb-safe-bottom border-t border-hairline bg-canvas px-3 pt-3 sm:px-6 sm:pt-4">
          <div className="mx-auto max-w-3xl">
            <ChatInput
              onSubmit={send}
              disabled={inputDisabled}
              placeholder={
                models.length === 0
                  ? "Loading models…"
                  : busy
                    ? "Generating…"
                    : "Ask anything (Shift+Enter for newline)"
              }
            />
          </div>
        </div>
          </>
        )}
      </main>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  const samples = [
    "Summarize my emails from this week",
    "What's on my calendar today?",
    "Draft a follow-up based on my last meeting",
    "Pull my open tasks and help me prioritize",
  ];
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <div className="text-2xl font-medium tracking-tight text-ink">
        Talk to your work.
      </div>
      <p className="max-w-md text-sm text-muted">
        Connect your tools and let AI get things done across your stack.
      </p>
      <div className="flex flex-wrap justify-center gap-2 pt-4">
        {samples.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-xs text-muted hover:bg-subtle hover:text-ink"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
