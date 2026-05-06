"use client";

import { useEffect, useRef, useState } from "react";

interface ThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

interface SidebarProps {
  userName: string;
  userEmail: string;
  activeThreadId?: string;
  openThreadIds: readonly string[];
  onOpenThread: (id: string) => void;
  onNewChat: () => void;
  onComingSoon: (label: string, description?: string) => void;
  onThreadDeleted: (id: string) => void;
  /** Bumped by parent whenever a thread changes (created/updated/deleted) so the list re-fetches. */
  refreshKey: number;
}

const PLACEHOLDER_TOOLS = [
  { label: "Microsoft Graph (Mail / Calendar / Files)", description: "Microsoft Graph integration lands in week 3 once IT approves the Entra app registration." },
  { label: "GitHub", description: "GitHub tools come after Microsoft Graph — week 8 or so." },
  { label: "Databricks", description: "Databricks integration is a candidate for the week-8 second integration." },
];

const PLACEHOLDER_RECIPES = [
  { label: "Morning Briefing", description: "First recipe ships in week 4 once the Microsoft Graph tools are wired up." },
];

export function Sidebar({
  userName,
  userEmail,
  activeThreadId,
  openThreadIds,
  onOpenThread,
  onNewChat,
  onComingSoon,
  onThreadDeleted,
  refreshKey,
}: SidebarProps) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/threads")
      .then((r) => r.json() as Promise<{ threads: ThreadSummary[] }>)
      .then((data) => {
        if (!cancelled) {
          setThreads(data.threads ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Close menus on outside click.
  useEffect(() => {
    function onDocClick() {
      setOpenMenuId(null);
      setUserMenuOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  async function deleteThread(id: string) {
    setOpenMenuId(null);
    const res = await fetch(`/api/threads/${id}`, { method: "DELETE" });
    if (res.ok) {
      setThreads((prev) => prev.filter((t) => t.id !== id));
      onThreadDeleted(id);
    }
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-zinc-200/80 bg-zinc-50 text-sm dark:border-zinc-800/80 dark:bg-zinc-900/40">
      <UserChip
        name={userName}
        email={userEmail}
        open={userMenuOpen}
        onToggle={(e) => {
          e.stopPropagation();
          setUserMenuOpen((v) => !v);
        }}
        onItem={(label) => {
          setUserMenuOpen(false);
          onComingSoon(label);
        }}
      />

      <button
        type="button"
        onClick={onNewChat}
        className="mx-2 mb-3 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-200 dark:hover:bg-zinc-800/60"
      >
        <PlusIcon /> New chat
      </button>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        <Section label="Chats">
          {loading ? (
            <EmptyHint>Loading…</EmptyHint>
          ) : threads.length === 0 ? (
            <EmptyHint>No chats yet</EmptyHint>
          ) : (
            threads.map((t) => (
              <ThreadItem
                key={t.id}
                title={t.title ?? "Untitled"}
                active={t.id === activeThreadId}
                isOpen={openThreadIds.includes(t.id)}
                menuOpen={openMenuId === t.id}
                onOpenMenu={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === t.id ? null : t.id);
                }}
                onClick={() => onOpenThread(t.id)}
                onRename={() => {
                  setOpenMenuId(null);
                  onComingSoon(
                    "Rename chat",
                    "Renaming chats lands soon — for now, the title is auto-derived from your first message.",
                  );
                }}
                onDelete={() => deleteThread(t.id)}
              />
            ))
          )}
        </Section>

        <Section label="Tools">
          {PLACEHOLDER_TOOLS.map((t) => (
            <PlaceholderItem
              key={t.label}
              label={t.label}
              onClick={() => onComingSoon(t.label, t.description)}
            />
          ))}
        </Section>

        <Section label="Recipes">
          {PLACEHOLDER_RECIPES.map((r) => (
            <PlaceholderItem
              key={r.label}
              label={r.label}
              onClick={() => onComingSoon(r.label, r.description)}
            />
          ))}
        </Section>
      </nav>
    </aside>
  );
}

function UserChip({
  name,
  email,
  open,
  onToggle,
  onItem,
}: {
  name: string;
  email: string;
  open: boolean;
  onToggle: (e: React.MouseEvent) => void;
  onItem: (label: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="relative px-2 pt-3 pb-2" ref={ref}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
      >
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {name}
          </div>
          <div className="truncate text-xs text-zinc-500 dark:text-zinc-500">
            {email}
          </div>
        </div>
        <ChevronDown />
      </button>
      {open ? (
        <div
          className="absolute left-2 right-2 top-full z-20 mt-1 overflow-hidden rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem onClick={() => onItem("Account settings")}>
            Account settings
          </MenuItem>
          <MenuItem onClick={() => onItem("Sign out")}>Sign out</MenuItem>
        </div>
      ) : null}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = (name?.[0] ?? "?").toUpperCase();
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-200 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      {initial}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function ThreadItem({
  title,
  active,
  isOpen,
  menuOpen,
  onOpenMenu,
  onClick,
  onRename,
  onDelete,
}: {
  title: string;
  active: boolean;
  isOpen: boolean;
  menuOpen: boolean;
  onOpenMenu: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`flex w-full items-center gap-2 truncate rounded-md py-1 pl-2 pr-7 text-left text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-200 dark:hover:bg-zinc-800/60 ${
          active ? "bg-zinc-200/80 dark:bg-zinc-800/80" : ""
        }`}
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            isOpen ? "bg-zinc-400 dark:bg-zinc-500" : "bg-transparent"
          }`}
        />
        <span className="truncate">{title}</span>
      </button>
      <button
        type="button"
        onClick={onOpenMenu}
        className={`absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-300/60 hover:text-zinc-700 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-100 ${
          menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        aria-label="More actions"
      >
        <DotsIcon />
      </button>
      {menuOpen ? (
        <div
          className="absolute right-1 top-full z-20 mt-1 w-36 overflow-hidden rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem onClick={onRename}>Rename</MenuItem>
          <MenuItem onClick={onDelete} danger>
            Delete
          </MenuItem>
        </div>
      ) : null}
    </div>
  );
}

function PlaceholderItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-zinc-500 hover:bg-zinc-200/60 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-300"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 rounded bg-zinc-200/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400">
        Soon
      </span>
    </button>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
        danger
          ? "text-red-600 dark:text-red-400"
          : "text-zinc-700 dark:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-1 text-xs text-zinc-400 dark:text-zinc-500">
      {children}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="text-zinc-400"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}
