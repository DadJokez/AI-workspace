"use client";

import {
  groupCommandPaletteItems,
  type CommandPaletteItem,
} from "@/lib/command-palette";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

interface ChatCommandActions {
  newChat: () => void;
  openArtifacts: () => void;
  openSettings: () => void;
  openThread: (threadId: string, title: string) => void;
}

type PaletteCommand =
  | { type: "new-chat" }
  | { type: "open-artifacts" }
  | { type: "open-settings" }
  | { type: "thread"; threadId: string; title: string }
  | { type: "toggle-theme" }
  | { type: "route"; href: string };

interface PaletteItem extends CommandPaletteItem {
  command: PaletteCommand;
  shortcut?: string;
}

interface PaletteData {
  threads: Array<{
    id: string;
    title: string | null;
    previewSummary: string | null;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string | null;
  }>;
  apps: Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
  }>;
  isAdmin: boolean;
}

interface CommandPaletteContextValue {
  openPalette: () => void;
  registerChatActions: (
    actions: MutableRefObject<ChatCommandActions>,
  ) => () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(
  null,
);

const EMPTY_DATA: PaletteData = {
  threads: [],
  skills: [],
  apps: [],
  isAdmin: false,
};

const ADMIN_ITEMS: readonly PaletteItem[] = [
  adminItem("users", "Users", "/admin"),
  adminItem("usage", "Usage", "/admin/usage"),
  adminItem("tools", "Tools", "/admin/tools"),
  adminItem("runs", "Runs", "/admin/runs"),
  adminItem("audit", "Audit", "/admin/audit"),
  adminItem("feedback", "Feedback", "/admin/feedback"),
];

function adminItem(id: string, label: string, href: string): PaletteItem {
  return {
    id: `admin:${id}`,
    group: "admin",
    label,
    description: `Open Admin ${label}`,
    keywords: ["workspace administration"],
    command: { type: "route", href },
  };
}

async function readJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

function toggleCurrentTheme() {
  const mountedToggle = document.querySelector<HTMLButtonElement>(
    "[data-theme-toggle]",
  );
  if (mountedToggle) {
    mountedToggle.click();
    return;
  }

  const nextDark = !document.documentElement.classList.contains("dark");
  document.documentElement.classList.toggle("dark", nextDark);
  document.documentElement.dataset.theme = nextDark ? "dark" : "light";
  try {
    localStorage.setItem("theme", nextDark ? "dark" : "light");
  } catch {
    // The visible theme still changes when storage is unavailable.
  }
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PaletteData>(EMPTY_DATA);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const chatActionsRef = useRef<MutableRefObject<ChatCommandActions> | null>(
    null,
  );

  const loadData = useCallback(() => {
    if (loadPromiseRef.current) return loadPromiseRef.current;
    setLoading(true);
    const promise = Promise.all([
      readJson<{ user?: { role?: string } }>("/api/me", {}),
      readJson<{ threads?: PaletteData["threads"] }>(
        "/api/threads?limit=50&scope=mine",
        {},
      ),
      readJson<{ skills?: PaletteData["skills"] }>("/api/skills", {}),
      readJson<{ apps?: PaletteData["apps"] }>("/api/apps", {}),
    ])
      .then(([me, threads, skills, apps]) => {
        setData({
          isAdmin: me.user?.role === "admin",
          threads: Array.isArray(threads.threads) ? threads.threads : [],
          skills: Array.isArray(skills.skills) ? skills.skills : [],
          apps: Array.isArray(apps.apps) ? apps.apps : [],
        });
      })
      .finally(() => {
        loadPromiseRef.current = null;
        setLoading(false);
      });
    loadPromiseRef.current = promise;
    return promise;
  }, []);

  const openPalette = useCallback(() => {
    setOpen(true);
    void loadData();
  }, [loadData]);

  const closePalette = useCallback(() => setOpen(false), []);

  const registerChatActions = useCallback(
    (actions: MutableRefObject<ChatCommandActions>) => {
      chatActionsRef.current = actions;
      return () => {
        if (chatActionsRef.current === actions) chatActionsRef.current = null;
      };
    },
    [],
  );

  const runCommand = useCallback(
    (command: PaletteCommand) => {
      closePalette();
      const chatActions = chatActionsRef.current?.current;
      switch (command.type) {
        case "new-chat":
          if (chatActions) chatActions.newChat();
          else router.push("/chat");
          return;
        case "open-artifacts":
          if (chatActions) chatActions.openArtifacts();
          else router.push("/chat?open=artifacts");
          return;
        case "open-settings":
          if (chatActions) chatActions.openSettings();
          else router.push("/chat?open=settings");
          return;
        case "thread":
          if (chatActions) {
            chatActions.openThread(command.threadId, command.title);
          } else {
            router.push(`/chat?threadId=${encodeURIComponent(command.threadId)}`);
          }
          return;
        case "toggle-theme":
          toggleCurrentTheme();
          return;
        case "route":
          if (pathname !== command.href) router.push(command.href);
      }
    },
    [closePalette, pathname, router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        runCommand({ type: "new-chat" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPalette, runCommand]);

  const items = useMemo<PaletteItem[]>(() => {
    const dynamic: PaletteItem[] = [
      ...data.threads.map((thread) => ({
        id: `thread:${thread.id}`,
        group: "chats" as const,
        label: thread.title?.trim() || "Untitled",
        description: thread.previewSummary,
        keywords: ["conversation", "thread"],
        command: {
          type: "thread" as const,
          threadId: thread.id,
          title: thread.title?.trim() || "Untitled",
        },
      })),
      ...data.skills.map((skill) => ({
        id: `skill:${skill.id}`,
        group: "skills" as const,
        label: skill.name,
        description: skill.description,
        keywords: ["agent", "skill"],
        command: { type: "route" as const, href: `/skills/${skill.id}` },
      })),
      ...data.apps.map((app) => ({
        id: `app:${app.id}`,
        group: "apps" as const,
        label: app.name,
        description: app.description,
        keywords: ["application", "deployed app"],
        command: { type: "route" as const, href: `/apps/${app.slug}` },
      })),
    ];
    if (data.isAdmin) dynamic.push(...ADMIN_ITEMS);
    dynamic.push(
      {
        id: "action:new-chat",
        group: "actions",
        label: "New chat",
        keywords: ["conversation", "thread"],
        shortcut: "⌘N",
        command: { type: "new-chat" },
      },
      {
        id: "action:theme",
        group: "actions",
        label: "Toggle theme",
        keywords: ["light", "dark", "appearance"],
        command: { type: "toggle-theme" },
      },
      {
        id: "action:settings",
        group: "actions",
        label: "Open settings",
        keywords: ["profile", "memory", "integrations", "preferences"],
        shortcut: "⌘,",
        command: { type: "open-settings" },
      },
      {
        id: "action:artifacts",
        group: "actions",
        label: "Open artifacts",
        keywords: ["files", "documents", "workspace"],
        command: { type: "open-artifacts" },
      },
    );
    return dynamic;
  }, [data]);

  const context = useMemo(
    () => ({ openPalette, registerChatActions }),
    [openPalette, registerChatActions],
  );

  return (
    <CommandPaletteContext.Provider value={context}>
      {children}
      {open ? (
        <CommandPaletteDialog
          items={items}
          loading={loading}
          onClose={closePalette}
          onSelect={runCommand}
        />
      ) : null}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error("useCommandPalette must be used within its provider");
  }
  return { openPalette: context.openPalette };
}

export function useRegisterCommandPaletteActions(
  actions: ChatCommandActions,
) {
  const context = useContext(CommandPaletteContext);
  if (!context) {
    throw new Error(
      "useRegisterCommandPaletteActions must be used within its provider",
    );
  }
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(
    () => context.registerChatActions(actionsRef),
    [context, context.registerChatActions],
  );
}

function CommandPaletteDialog({
  items,
  loading,
  onClose,
  onSelect,
}: {
  items: PaletteItem[];
  loading: boolean;
  onClose: () => void;
  onSelect: (command: PaletteCommand) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const listboxId = useId();
  const groups = useMemo(
    () => groupCommandPaletteItems(items, query),
    [items, query],
  );
  const visibleItems = groups.flatMap((group) => group.items);
  const activeItem = visibleItems[activeIndex];
  const activeOptionId = activeItem
    ? `${listboxId}-option-${activeItem.id.replace(/[^a-z0-9_-]/gi, "-")}`
    : undefined;

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex((current) =>
      visibleItems.length === 0 ? 0 : Math.min(current, visibleItems.length - 1),
    );
  }, [visibleItems.length]);

  useEffect(() => {
    if (!activeOptionId) return;
    document
      .getElementById(activeOptionId)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  function moveActive(delta: number) {
    if (visibleItems.length === 0) return;
    setActiveIndex(
      (current) => (current + delta + visibleItems.length) % visibleItems.length,
    );
  }

  function handleDialogKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const first = inputRef.current;
    const last = closeRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center bg-black/55 px-3 pt-[min(16vh,8rem)] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleDialogKeyDown}
        className="flex max-h-[min(70vh,42rem)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-hairline px-3">
          <SearchIcon />
          <input
            ref={inputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === "Enter" && activeItem) {
                event.preventDefault();
                onSelect(activeItem.command);
              }
            }}
            placeholder="Search chats, skills, apps, and actions…"
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-ink placeholder:text-muted"
          />
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close command palette"
            className="rounded border border-hairline px-1.5 py-1 text-2xs text-muted hover:bg-subtle hover:text-ink"
          >
            Esc
          </button>
        </div>

        <div
          id={listboxId}
          role="listbox"
          aria-busy={loading}
          className="min-h-0 overflow-y-auto p-2"
        >
          {visibleItems.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted">
              {loading ? "Loading workspace…" : "No matching commands."}
            </div>
          ) : (
            groups.map((group) => (
              <div
                key={group.id}
                role="group"
                aria-labelledby={`${listboxId}-group-${group.id}`}
                className="pb-2 last:pb-0"
              >
                <div
                  id={`${listboxId}-group-${group.id}`}
                  className="px-2 py-1 text-2xs font-medium uppercase tracking-wider text-muted"
                >
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const itemIndex = visibleItems.indexOf(item);
                  const active = itemIndex === activeIndex;
                  const optionId = `${listboxId}-option-${item.id.replace(/[^a-z0-9_-]/gi, "-")}`;
                  return (
                    <button
                      key={item.id}
                      id={optionId}
                      type="button"
                      role="option"
                      aria-selected={active}
                      tabIndex={-1}
                      onMouseMove={() => setActiveIndex(itemIndex)}
                      onClick={() => onSelect(item.command)}
                      className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left ${
                        active ? "bg-subtle text-ink" : "text-muted"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {item.label}
                        </span>
                        {item.description ? (
                          <span className="mt-0.5 block truncate text-xs text-muted">
                            {item.description}
                          </span>
                        ) : null}
                      </span>
                      {item.shortcut ? (
                        <kbd className="shrink-0 text-2xs text-muted">
                          {item.shortcut}
                        </kbd>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <footer className="flex items-center gap-4 border-t border-hairline px-3 py-2 text-2xs text-muted">
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span>Esc Close</span>
          {loading && visibleItems.length > 0 ? (
            <span className="ml-auto">Updating…</span>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="shrink-0 text-muted"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4" />
      <path d="m13 13-3-3" />
    </svg>
  );
}
