"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** When true: rendered dimmed, click is a no-op. */
  disabled?: boolean;
  /** Tiny right-side label, e.g. "Soon" / "Later" for roadmap placeholders. */
  badge?: string;
  /** Tooltip on hover. */
  tooltip?: string;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

/**
 * Nav layout maps to journeys J2-J5 — chat (J1) is the whole app, so it
 * doesn't appear as a nav item. New chats start from the "+" next to the
 * History header. Tools (J2) is live for connecting integrations; the
 * rest are visible-but-disabled so the roadmap is legible at a glance.
 */
const groups: NavGroup[] = [
  {
    items: [
      { id: "tools", label: "Tools", icon: <IconTool /> },
      { id: "vault", label: "Vault", icon: <IconVault /> },
    ],
  },
  {
    label: "Coming soon",
    items: [
      {
        id: "scheduled",
        label: "Scheduled",
        icon: <IconCalendar />,
        disabled: true,
        badge: "Soon",
        tooltip: "Coming soon — agents that run on a schedule",
      },
    ],
  },
  {
    label: "Later",
    items: [
      {
        id: "apps",
        label: "Apps",
        icon: <IconGrid />,
        disabled: true,
        badge: "Later",
        tooltip: "Future — build and deploy apps from chat",
      },
      {
        id: "shared",
        label: "Shared",
        icon: <IconShare />,
        disabled: true,
        badge: "Later",
        tooltip: "Future — share threads, tools, and apps with teammates",
      },
    ],
  },
  {
    items: [
      { id: "settings", label: "Settings", icon: <IconCog /> },
    ],
  },
];

export interface ThreadSummary {
  id: string;
  title: string | null;
  defaultModelId: string;
  summary: string | null;
  summaryUpdatedAt: string | null;
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
  /** When true, the Admin nav group is rendered. Driven by the session role. */
  isAdmin?: boolean;
  /** Sign out of the current NextAuth session. When omitted, the menu item is hidden. */
  onSignOut?: () => void;
  /** Rename a thread. Resolves on success, rejects on error. */
  onRenameThread?: (threadId: string, title: string) => Promise<void>;
  /** Delete a thread. Resolves on success, rejects on error. */
  onDeleteThread?: (threadId: string) => Promise<void>;
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
  isAdmin,
  onSignOut,
  onRenameThread,
  onDeleteThread,
}: Props) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const userMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLLIElement>(null);

  const navGroups = useMemo<NavGroup[]>(() => {
    if (!isAdmin) return groups;
    // Insert an Admin entry above the trailing Settings group.
    const adminGroup: NavGroup = {
      label: "Admin",
      items: [
        { id: "admin", label: "Admin", icon: <IconShield /> },
      ],
    };
    return [...groups.slice(0, -1), adminGroup, groups[groups.length - 1]!];
  }, [isAdmin]);

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

  // History label flips to "Workspace" for admins so it's obvious they're
  // looking at threads from every user, not just their own.
  const historyLabel = isAdmin ? "Workspace" : "History";

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (renamingId) {
          setRenamingId(null);
          setRenameDraft("");
          return;
        }
        if (pendingDeleteId) {
          setPendingDeleteId(null);
          return;
        }
        if (openMenuId) {
          setOpenMenuId(null);
          return;
        }
        if (userMenuOpen) {
          setUserMenuOpen(false);
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, renamingId, pendingDeleteId, openMenuId, userMenuOpen]);

  // Close the user dropdown / thread popover on outside click.
  useEffect(() => {
    if (!userMenuOpen && !openMenuId) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        userMenuOpen &&
        userMenuRef.current &&
        !userMenuRef.current.contains(target)
      ) {
        setUserMenuOpen(false);
      }
      if (
        openMenuId &&
        threadMenuRef.current &&
        !threadMenuRef.current.contains(target)
      ) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [userMenuOpen, openMenuId]);

  function handleNewChat() {
    onNewChat();
    onClose();
  }

  function handleNavClick(item: NavItem) {
    if (item.disabled) return;
    onNavSelect?.(item.id);
    onClose();
  }

  function handleThreadClick(threadId: string, title: string) {
    if (renamingId === threadId) return;
    onOpenThread(threadId, title);
    onClose();
  }

  function startRename(t: ThreadSummary) {
    setOpenMenuId(null);
    setRenamingId(t.id);
    setRenameDraft(t.title?.trim() || "");
  }

  async function commitRename(threadId: string) {
    const next = renameDraft.trim();
    if (!next || !onRenameThread) {
      setRenamingId(null);
      setRenameDraft("");
      return;
    }
    setRenameSaving(true);
    try {
      await onRenameThread(threadId, next);
      setRenamingId(null);
      setRenameDraft("");
    } catch {
      // Keep the editor open so the user can retry; visible failure is the
      // unsaved input. Parent surfaces toast/log if it wants to.
    } finally {
      setRenameSaving(false);
    }
  }

  async function confirmDelete() {
    const id = pendingDeleteId;
    if (!id || !onDeleteThread) {
      setPendingDeleteId(null);
      return;
    }
    setDeleting(true);
    try {
      await onDeleteThread(id);
      setPendingDeleteId(null);
    } catch {
      // Leave the dialog open on failure; parent decides how to surface.
    } finally {
      setDeleting(false);
    }
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
        <div
          className="relative flex shrink-0 items-center gap-2.5 px-3 py-3"
          ref={userMenuRef}
        >
          <button
            type="button"
            onClick={() => onSignOut && setUserMenuOpen((v) => !v)}
            disabled={!onSignOut}
            aria-haspopup={onSignOut ? "menu" : undefined}
            aria-expanded={onSignOut ? userMenuOpen : undefined}
            aria-label={onSignOut ? "Account menu" : undefined}
            className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left ${
              onSignOut ? "hover:bg-subtle" : "cursor-default"
            }`}
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-subtle text-[11px] font-medium text-ink">
              {initials || "AI"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">
                {userName ?? "Workspace"}
              </div>
              {userEmail ? (
                <div className="truncate text-[11px] text-muted">
                  {userEmail}
                </div>
              ) : null}
            </div>
            {onSignOut ? (
              <svg
                viewBox="0 0 16 16"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className={`shrink-0 text-muted transition-transform ${
                  userMenuOpen ? "rotate-180" : ""
                }`}
              >
                <path d="m4 6 4 4 4-4" />
              </svg>
            ) : null}
          </button>
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

          {userMenuOpen && onSignOut ? (
            <div
              role="menu"
              className="absolute left-3 right-3 top-[calc(100%-4px)] z-10 overflow-hidden rounded-md border border-hairline bg-surface shadow-md"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  onSignOut();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-subtle"
              >
                <IconSignOut />
                <span>Sign out</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 px-2 pb-1.5 pt-2">
          <div className="flex min-h-[28px] items-center gap-1 px-2 pb-1 pt-1">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              aria-expanded={historyOpen}
              aria-label={
                historyOpen
                  ? `Collapse ${historyLabel.toLowerCase()}`
                  : `Expand ${historyLabel.toLowerCase()}`
              }
              className="flex flex-1 items-center gap-1.5 rounded-md text-left text-[10px] font-medium uppercase tracking-wider text-muted hover:text-ink"
            >
              <svg
                viewBox="0 0 16 16"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform ${historyOpen ? "rotate-90" : ""}`}
                aria-hidden="true"
              >
                <path d="m6 4 4 4-4 4" />
              </svg>
              <span>{historyLabel}</span>
            </button>
            <button
              type="button"
              onClick={handleNewChat}
              aria-label="New chat"
              title="New chat"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-subtle hover:text-ink"
            >
              <IconPlus />
            </button>
          </div>
          {historyOpen ? (
            <div className="max-h-[40vh] overflow-y-auto">
              {threadsLoading && threads.length === 0 ? (
                <ThreadsSkeleton />
              ) : threadsError && threads.length === 0 ? (
                <div className="px-2 py-2 text-[12px] text-muted">
                  Couldn&apos;t load history. Try again later.
                </div>
              ) : threads.length === 0 ? (
                <div className="px-2 py-2 text-[12px] text-muted">
                  No conversations yet.
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
                          const isRenaming = renamingId === t.id;
                          const isMenuOpen = openMenuId === t.id;
                          const isPendingDelete = pendingDeleteId === t.id;
                          return (
                            <li
                              key={t.id}
                              className="group/thread relative"
                              ref={isMenuOpen ? threadMenuRef : null}
                            >
                              {isRenaming ? (
                                <div
                                  className={`flex min-h-[44px] w-full items-center gap-1 rounded-md px-2 py-1.5 md:min-h-0 ${
                                    active ? "bg-subtle" : "bg-subtle/60"
                                  }`}
                                >
                                  <input
                                    autoFocus
                                    value={renameDraft}
                                    onChange={(e) =>
                                      setRenameDraft(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.preventDefault();
                                        void commitRename(t.id);
                                      } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        setRenamingId(null);
                                        setRenameDraft("");
                                      }
                                    }}
                                    onBlur={() => void commitRename(t.id)}
                                    disabled={renameSaving}
                                    aria-label="Rename thread"
                                    className="min-w-0 flex-1 rounded border border-hairline bg-canvas px-1.5 py-1 text-[13px] text-ink outline-none focus:border-ink/30"
                                  />
                                </div>
                              ) : (
                                <div
                                  className={`flex min-h-[44px] w-full items-center gap-1 rounded-md md:min-h-0 ${
                                    active
                                      ? "bg-subtle text-ink"
                                      : "text-muted hover:bg-subtle hover:text-ink"
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleThreadClick(t.id, t.title ?? "")
                                    }
                                    aria-current={active ? "page" : undefined}
                                    title={title}
                                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-[13px] md:py-1.5"
                                  >
                                    <span className="flex-1 truncate">
                                      {title}
                                    </span>
                                  </button>
                                  {(onRenameThread || onDeleteThread) ? (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenMenuId((v) =>
                                          v === t.id ? null : t.id,
                                        );
                                      }}
                                      aria-label="Thread actions"
                                      aria-haspopup="menu"
                                      aria-expanded={isMenuOpen}
                                      className={`mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-canvas/60 hover:text-ink md:h-5 md:w-5 ${
                                        isMenuOpen
                                          ? "opacity-100"
                                          : "md:opacity-0 md:group-hover/thread:opacity-100 md:focus-visible:opacity-100"
                                      }`}
                                    >
                                      <IconDots />
                                    </button>
                                  ) : null}
                                </div>
                              )}
                              {isMenuOpen ? (
                                <div
                                  role="menu"
                                  className="absolute right-1 top-full z-20 mt-0.5 w-40 overflow-hidden rounded-md border border-hairline bg-surface shadow-md"
                                >
                                  {onRenameThread ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => startRename(t)}
                                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-subtle"
                                    >
                                      <IconPencil />
                                      <span>Rename</span>
                                    </button>
                                  ) : null}
                                  {onDeleteThread ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => {
                                        setOpenMenuId(null);
                                        setPendingDeleteId(t.id);
                                      }}
                                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-subtle"
                                    >
                                      <IconTrash />
                                      <span>Delete</span>
                                    </button>
                                  ) : null}
                                </div>
                              ) : null}
                              {isPendingDelete ? (
                                <DeleteConfirm
                                  title={title}
                                  busy={deleting}
                                  onCancel={() => setPendingDeleteId(null)}
                                  onConfirm={confirmDelete}
                                />
                              ) : null}
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
          {navGroups.map((group, gi) => (
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
                  const disabled = !!item.disabled;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => handleNavClick(item)}
                        disabled={disabled}
                        aria-current={active ? "page" : undefined}
                        aria-disabled={disabled || undefined}
                        title={item.tooltip}
                        className={`flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] md:min-h-0 md:py-1.5 ${
                          disabled
                            ? "cursor-not-allowed text-muted/60"
                            : active
                              ? "bg-subtle text-ink"
                              : "text-muted hover:bg-subtle hover:text-ink"
                        }`}
                      >
                        <span className="flex h-4 w-4 items-center justify-center text-current">
                          {item.icon}
                        </span>
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.badge ? (
                          <span className="rounded bg-subtle px-1.5 text-[10px] uppercase tracking-wider text-muted">
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
      </aside>
    </>
  );
}

function DeleteConfirm({
  title,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="false"
      className="absolute left-1 right-1 top-full z-30 mt-1 rounded-md border border-hairline bg-surface p-2 shadow-md"
    >
      <p className="px-1 pb-2 text-[12px] text-ink">
        Delete <span className="font-medium">{title}</span>? This can&apos;t be
        undone.
      </p>
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-hairline bg-canvas px-2 py-1 text-[11px] text-ink hover:bg-subtle disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded border border-hairline bg-ink px-2 py-1 text-[11px] font-medium text-canvas hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
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

function IconDots() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d="m11 2.5 2.5 2.5L6 12.5l-3 .5.5-3 7.5-7.5Z" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.5 8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" />
    </svg>
  );
}

function IconSignOut() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d="M9 4V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-1M11 5l3 3-3 3M6 8h8" />
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

function IconVault() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <rect x="2.5" y="3" width="11" height="10.5" rx="1.5" />
      <path d="M5.5 3V2.5A1.5 1.5 0 0 1 7 1h2a1.5 1.5 0 0 1 1.5 1.5V3" />
      <circle cx="8" cy="8" r="1.3" />
      <path d="M8 9.3v1.5" />
    </svg>
  );
}

function IconCalendar() {
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
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </svg>
  );
}

function IconGrid() {
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
      <rect x="2.5" y="2.5" width="4" height="4" rx="0.6" />
      <rect x="9.5" y="2.5" width="4" height="4" rx="0.6" />
      <rect x="2.5" y="9.5" width="4" height="4" rx="0.6" />
      <rect x="9.5" y="9.5" width="4" height="4" rx="0.6" />
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

function IconShield() {
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
      <path d="M8 1.8 2.8 3.6v4.2c0 3 2.2 5.5 5.2 6.4 3-.9 5.2-3.4 5.2-6.4V3.6L8 1.8Z" />
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
