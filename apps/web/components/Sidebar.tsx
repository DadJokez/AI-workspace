"use client";

import { useEffect, useMemo, useState } from "react";

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: string;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const groups: NavGroup[] = [
  {
    items: [
      { id: "chat", label: "Chat", icon: <IconChat /> },
      { id: "search", label: "Search", icon: <IconSearch /> },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "tools", label: "Tools", icon: <IconTool /> },
      { id: "skills", label: "Skills", icon: <IconSparkle /> },
      { id: "recipes", label: "Recipes", icon: <IconBook /> },
    ],
  },
  {
    label: "Library",
    items: [
      { id: "history", label: "History", icon: <IconClock /> },
      { id: "shared", label: "Shared with me", icon: <IconShare /> },
    ],
  },
  {
    label: "Account",
    items: [
      { id: "settings", label: "Settings", icon: <IconCog /> },
      { id: "help", label: "Help", icon: <IconHelp /> },
    ],
  },
];

export interface ThreadSummary {
  id: string;
  title: string | null;
  defaultModelId: string;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  userName?: string;
  userEmail?: string;
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  threads: ThreadSummary[];
  threadsLoading: boolean;
  threadsError?: string;
  activeThreadId?: string;
  onOpenThread: (threadId: string, title: string) => void;
  /** Currently-active top-level view. Drives nav-item highlight. */
  activeNavId?: string;
  /** Fired when a static nav item is clicked. Parent decides whether the id maps to a real view. */
  onNavSelect?: (id: string) => void;
}

interface ThreadGroup {
  label: string;
  threads: ThreadSummary[];
}

function groupThreadsByRecency(threads: ThreadSummary[]): ThreadGroup[] {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfPrevious7 = new Date(startOfToday);
  startOfPrevious7.setDate(startOfPrevious7.getDate() - 7);

  const buckets: Record<string, ThreadSummary[]> = {
    today: [],
    yesterday: [],
    previous7: [],
    older: [],
  };

  for (const t of threads) {
    const d = new Date(t.updatedAt);
    if (d >= startOfToday) buckets.today!.push(t);
    else if (d >= startOfYesterday) buckets.yesterday!.push(t);
    else if (d >= startOfPrevious7) buckets.previous7!.push(t);
    else buckets.older!.push(t);
  }

  const out: ThreadGroup[] = [];
  if (buckets.today!.length)
    out.push({ label: "Today", threads: buckets.today! });
  if (buckets.yesterday!.length)
    out.push({ label: "Yesterday", threads: buckets.yesterday! });
  if (buckets.previous7!.length)
    out.push({ label: "Previous 7 days", threads: buckets.previous7! });
  if (buckets.older!.length)
    out.push({ label: "Older", threads: buckets.older! });
  return out;
}

export function Sidebar({
  userName,
  userEmail,
  open,
  onClose,
  onNewChat,
  threads,
  threadsLoading,
  threadsError,
  activeThreadId,
  onOpenThread,
  activeNavId,
  onNavSelect,
}: Props) {
  const [chatsOpen, setChatsOpen] = useState(true);

  const initials = (userName ?? userEmail ?? "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  const threadGroups = useMemo(
    () => groupThreadsByRecency(threads),
    [threads],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  function handleNewChat() {
    onNewChat();
    onClose();
  }

  function handleNavClick(id: string) {
    onNavSelect?.(id);
    onClose();
  }

  function handleThreadClick(threadId: string, title: string) {
    onOpenThread(threadId, title);
    onClose();
  }

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/40 transition-opacity md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        aria-label="Primary"
        data-density="nav"
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-hairline bg-sidebar transition-transform duration-200 md:static md:z-auto md:w-60 md:max-w-none md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex shrink-0 items-center gap-2.5 px-3 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-subtle text-[11px] font-medium text-ink">
            {initials || "AI"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">
              {userName ?? "Workspace"}
            </div>
            {userEmail ? (
              <div className="truncate text-[11px] text-muted">{userEmail}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink md:hidden"
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        <div className="shrink-0 px-2">
          <button
            type="button"
            onClick={handleNewChat}
            className="flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-ink hover:bg-subtle md:min-h-0 md:py-1.5"
          >
            <IconPlus />
            <span>New chat</span>
          </button>
        </div>

        <div className="shrink-0 px-2 pb-1.5 pt-2">
          <div className="mx-2 mb-1.5 h-px bg-hairline" aria-hidden />
          <button
            type="button"
            onClick={() => setChatsOpen((v) => !v)}
            aria-expanded={chatsOpen}
            className="flex min-h-[28px] w-full items-center justify-between gap-2 rounded-md px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted hover:text-ink"
          >
            <span>Chats</span>
            <svg
              viewBox="0 0 16 16"
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${chatsOpen ? "rotate-90" : ""}`}
              aria-hidden="true"
            >
              <path d="m6 4 4 4-4 4" />
            </svg>
          </button>
          {chatsOpen ? (
            <div className="max-h-[40vh] overflow-y-auto">
              {threadsLoading && threads.length === 0 ? (
                <ThreadsSkeleton />
              ) : threadsError && threads.length === 0 ? (
                <div className="px-2 py-2 text-[12px] text-muted">
                  Couldn&apos;t load chats. Try again later.
                </div>
              ) : threads.length === 0 ? (
                <div className="px-2 py-2 text-[12px] text-muted">
                  No chats yet.
                </div>
              ) : (
                <div className="flex flex-col">
                  {threadGroups.map((group) => (
                    <div key={group.label} className="pb-1.5">
                      <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted/80">
                        {group.label}
                      </div>
                      <ul className="flex flex-col">
                        {group.threads.map((t) => {
                          const active = t.id === activeThreadId;
                          const title = t.title?.trim() || "Untitled";
                          return (
                            <li key={t.id}>
                              <button
                                type="button"
                                onClick={() =>
                                  handleThreadClick(t.id, t.title ?? "")
                                }
                                aria-current={active ? "page" : undefined}
                                title={title}
                                className={`flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] md:min-h-0 md:py-1.5 ${
                                  active
                                    ? "bg-subtle text-ink"
                                    : "text-muted hover:bg-subtle hover:text-ink"
                                }`}
                              >
                                <span className="flex-1 truncate">{title}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <nav className="shrink-0 px-2 pb-2">
          {groups.map((group, gi) => (
            <div key={gi} className="py-1.5">
              <div className="mx-2 mb-1.5 h-px bg-hairline" aria-hidden />
              {group.label ? (
                <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted">
                  {group.label}
                </div>
              ) : null}
              <ul className="flex flex-col">
                {group.items.map((item) => {
                  const active = item.id === activeNavId;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => handleNavClick(item.id)}
                        aria-current={active ? "page" : undefined}
                        className={`flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] md:min-h-0 md:py-1.5 ${
                          active
                            ? "bg-subtle text-ink"
                            : "text-muted hover:bg-subtle hover:text-ink"
                        }`}
                      >
                        <span className="flex h-4 w-4 items-center justify-center text-current">
                          {item.icon}
                        </span>
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.badge ? (
                          <span className="rounded bg-subtle px-1.5 text-[10px] text-muted">
                            {item.badge}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div aria-hidden className="flex-1" />

        <div className="shrink-0 border-t border-hairline px-3 py-2 text-[11px] text-muted">
          Week 1 build · Hardcoded auth
        </div>
      </aside>
    </>
  );
}

function ThreadsSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-5 w-full animate-pulse rounded bg-subtle"
          aria-hidden
        />
      ))}
    </div>
  );
}

function IconPlus() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 11H6.5L4 13.5V11a1.5 1.5 0 0 1-1.5-1.5z" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <circle cx="7" cy="7" r="4" />
      <path d="m13 13-3-3" />
    </svg>
  );
}

function IconTool() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path d="M10.8 2.2a3 3 0 0 0-3.9 3.9l-4.4 4.4a1.4 1.4 0 0 0 2 2l4.4-4.4a3 3 0 0 0 3.9-3.9l-1.7 1.7-1.4-1.4z" />
    </svg>
  );
}

function IconSparkle() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path d="M8 2v4M8 10v4M2 8h4M10 8h4" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path d="M3 3h6a2 2 0 0 1 2 2v8H5a2 2 0 0 0-2 2zM11 5a2 2 0 0 1 2-2v10a2 2 0 0 0-2 2" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </svg>
  );
}

function IconShare() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <circle cx="4" cy="8" r="1.6" />
      <circle cx="12" cy="4" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="m5.5 7.2 5-2.4M5.5 8.8l5 2.4" />
    </svg>
  );
}

function IconCog() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </svg>
  );
}

function IconHelp() {
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
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.5 6.2A1.5 1.5 0 0 1 9.5 6.2c0 1.3-1.5 1.3-1.5 2.3" />
      <circle cx="8" cy="11" r="0.6" fill="currentColor" />
    </svg>
  );
}
