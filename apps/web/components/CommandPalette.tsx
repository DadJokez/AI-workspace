"use client";

import {
  groupCommandPaletteItems,
  type CommandPaletteApiResponse,
  type CommandPaletteItem,
  type CommandPaletteReadinessState,
  type CommandPaletteServerCommand,
} from "@/lib/command-palette";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
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
  currentThreadId?: string;
  newChat: () => void;
  openArtifact: (
    artifact: WorkspaceArtifactSummary,
    threadTitle?: string,
  ) => void;
  openArtifacts: () => void;
  openSettings: (
    section?: "profile" | "memory" | "integrations",
    focusId?: string,
  ) => void;
  openStudio: () => void;
  branchCurrentThread: () => void;
  openThread: (threadId: string, title: string) => void;
  uploadFile: () => void;
}

type PaletteCommand =
  | CommandPaletteServerCommand
  | { type: "new-chat" }
  | { type: "open-artifacts" }
  | { type: "open-settings" }
  | { type: "open-studio" }
  | { type: "branch-work" }
  | { type: "upload-file" }
  | { type: "toggle-theme" }
  | { type: "route"; href: string };

interface PaletteItem extends CommandPaletteItem {
  command: PaletteCommand;
  shortcut?: string;
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

const EMPTY_DATA: CommandPaletteApiResponse = {
  items: [],
  isAdmin: false,
  partialSections: [],
  durationMs: 0,
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
  const [data, setData] = useState<CommandPaletteApiResponse>(EMPTY_DATA);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runningSkillId, setRunningSkillId] = useState<string | null>(null);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const chatActionsRef = useRef<MutableRefObject<ChatCommandActions> | null>(
    null,
  );

  const loadData = useCallback(() => {
    if (loadPromiseRef.current) return loadPromiseRef.current;
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams();
    const currentThreadId =
      chatActionsRef.current?.current.currentThreadId?.trim();
    if (currentThreadId) params.set("threadId", currentThreadId);
    const url = `/api/command-palette${params.size ? `?${params.toString()}` : ""}`;
    const startedAt = performance.now();
    const promise = fetch(url, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Workspace search is temporarily unavailable.");
        }
        const next = (await response.json()) as CommandPaletteApiResponse;
        setData({
          items: Array.isArray(next.items) ? next.items : [],
          isAdmin: next.isAdmin === true,
          partialSections: Array.isArray(next.partialSections)
            ? next.partialSections
            : [],
          durationMs:
            typeof next.durationMs === "number" ? next.durationMs : 0,
        });
        try {
          performance.measure("comparative-command-palette-load", {
            start: startedAt,
            end: performance.now(),
            detail: { serverDurationMs: next.durationMs },
          });
        } catch {
          // Search still succeeds when browser performance marks are unavailable.
        }
      })
      .catch((error) => {
        setData(EMPTY_DATA);
        setLoadError(
          error instanceof Error
            ? error.message
            : "Workspace search is temporarily unavailable.",
        );
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
    setActionError(null);
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
      const chatActions = chatActionsRef.current?.current;
      switch (command.type) {
        case "new-chat":
          closePalette();
          if (chatActions) chatActions.newChat();
          else router.push("/chat");
          return;
        case "open-artifacts":
          closePalette();
          if (chatActions) chatActions.openArtifacts();
          else router.push("/chat?open=artifacts");
          return;
        case "open-settings":
          closePalette();
          if (chatActions) chatActions.openSettings("profile");
          else router.push("/chat?open=settings");
          return;
        case "open-studio":
          closePalette();
          if (chatActions) chatActions.openStudio();
          else router.push("/chat?open=studio");
          return;
        case "branch-work":
          closePalette();
          chatActions?.branchCurrentThread();
          return;
        case "upload-file":
          closePalette();
          if (chatActions) chatActions.uploadFile();
          else router.push("/chat?open=upload");
          return;
        case "thread":
          closePalette();
          if (chatActions) {
            chatActions.openThread(command.threadId, command.title);
          } else {
            router.push(`/chat?threadId=${encodeURIComponent(command.threadId)}`);
          }
          return;
        case "artifact": {
          closePalette();
          if (chatActions) {
            chatActions.openArtifact(command.artifact, command.threadTitle);
          } else {
            const params = new URLSearchParams({
              artifactId: command.artifact.id,
            });
            if (command.artifact.threadId) {
              params.set("threadId", command.artifact.threadId);
            }
            router.push(`/chat?${params.toString()}`);
          }
          return;
        }
        case "settings": {
          closePalette();
          if (chatActions) {
            chatActions.openSettings(command.section, command.focusId);
          } else {
            const params = new URLSearchParams({
              open: "settings",
              section: command.section,
            });
            if (command.focusId) params.set("focus", command.focusId);
            router.push(`/chat?${params.toString()}`);
          }
          return;
        }
        case "run-skill": {
          setRunningSkillId(command.skillId);
          setActionError(null);
          void fetch(`/api/skills/${encodeURIComponent(command.skillId)}/run`, {
            method: "POST",
            credentials: "include",
          })
            .then(async (response) => {
              const body = (await response.json().catch(() => ({}))) as {
                threadId?: string;
                message?: string;
              };
              if (!response.ok || !body.threadId) {
                throw new Error(
                  body.message ?? "Comparative could not start this Skill.",
                );
              }
              closePalette();
              const title = `Skill: ${command.skillName}`;
              if (chatActions) chatActions.openThread(body.threadId, title);
              else {
                router.push(
                  `/chat?threadId=${encodeURIComponent(body.threadId)}`,
                );
              }
            })
            .catch((error) => {
              setActionError(
                error instanceof Error
                  ? error.message
                  : "Comparative could not start this Skill.",
              );
            })
            .finally(() => setRunningSkillId(null));
          return;
        }
        case "toggle-theme":
          closePalette();
          toggleCurrentTheme();
          return;
        case "route":
          closePalette();
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
    const dynamic: PaletteItem[] = data.items.map((item) => ({ ...item }));
    const currentThreadId = open
      ? chatActionsRef.current?.current.currentThreadId
      : undefined;
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
      {
        id: "action:studio",
        group: "actions",
        label: "Open Contribution Studio",
        keywords: ["work mode", "activity", "files", "browser"],
        command: { type: "open-studio" },
      },
      {
        id: "action:upload",
        group: "actions",
        label: "Upload a file",
        keywords: ["attach", "document", "image", "context"],
        command: { type: "upload-file" },
      },
      {
        id: "action:connect-tool",
        group: "actions",
        label: "Connect a tool",
        keywords: ["integration", "provider", "oauth", "settings"],
        command: { type: "settings", section: "integrations" },
      },
    );
    if (currentThreadId) {
      dynamic.push({
        id: "action:branch-work",
        group: "actions",
        label: "Try another approach",
        description: "Start an independent chat from the current work",
        keywords: ["branch", "alternate", "fork", "experiment"],
        command: { type: "branch-work" },
      });
    }
    return dynamic;
  }, [data, open]);

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
          loadError={loadError}
          actionError={actionError}
          partialSections={data.partialSections}
          runningSkillId={runningSkillId}
          onClose={closePalette}
          onRetry={() => void loadData()}
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
  loadError,
  actionError,
  partialSections,
  runningSkillId,
  onClose,
  onRetry,
  onSelect,
}: {
  items: PaletteItem[];
  loading: boolean;
  loadError: string | null;
  actionError: string | null;
  partialSections: CommandPaletteApiResponse["partialSections"];
  runningSkillId: string | null;
  onClose: () => void;
  onRetry: () => void;
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
            placeholder="Search chats, files, memory, tools, and actions…"
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
          {actionError ? (
            <div
              role="alert"
              className="mb-2 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-xs text-danger"
            >
              {actionError}
            </div>
          ) : null}
          {visibleItems.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-3 py-8 text-center text-sm text-muted">
              <span>
                {loading
                  ? "Loading workspace…"
                  : loadError
                    ? loadError
                    : "No matching commands."}
              </span>
              {loadError && !loading ? (
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-md border border-hairline px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-subtle"
                >
                  Try again
                </button>
              ) : null}
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
                  const readinessDescriptionId = item.readiness
                    ? `${optionId}-readiness`
                    : undefined;
                  return (
                    <button
                      key={item.id}
                      id={optionId}
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-describedby={readinessDescriptionId}
                      tabIndex={-1}
                      onMouseMove={() => setActiveIndex(itemIndex)}
                      onClick={() => onSelect(item.command)}
                      disabled={
                        item.command.type === "run-skill" &&
                        runningSkillId === item.command.skillId
                      }
                      className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left ${
                        active ? "bg-subtle text-ink" : "text-muted"
                      } disabled:cursor-wait disabled:opacity-60`}
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
                      {item.readiness ? (
                        <>
                          <span
                            className={`flex shrink-0 items-center gap-1.5 text-2xs ${readinessColor(item.readiness.state)}`}
                            title={item.readiness.detail}
                          >
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-current"
                              aria-hidden="true"
                            />
                            {item.command.type === "run-skill" &&
                            runningSkillId === item.command.skillId
                              ? "Starting"
                              : item.readiness.label}
                          </span>
                          <span
                            id={readinessDescriptionId}
                            className="sr-only"
                          >
                            {item.readiness.detail}
                          </span>
                        </>
                      ) : null}
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
          ) : loadError && visibleItems.length > 0 ? (
            <span className="ml-auto flex items-center gap-2">
              <span role="status">Workspace results unavailable</span>
              <button
                type="button"
                onClick={onRetry}
                aria-label="Retry workspace search"
                className="font-medium text-ink hover:underline"
              >
                Retry
              </button>
            </span>
          ) : partialSections.length > 0 ? (
            <span className="ml-auto" role="status">
              Some workspace results are unavailable
            </span>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function readinessColor(state: CommandPaletteReadinessState): string {
  if (state === "ready") return "text-success";
  if (state === "review_required") return "text-ink";
  if (state === "policy_blocked") return "text-danger";
  return "text-muted";
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
