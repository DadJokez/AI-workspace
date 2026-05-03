"use client";

import { useState } from "react";

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

interface Props {
  userName?: string;
  userEmail?: string;
  onNewChat: () => void;
}

export function Sidebar({ userName, userEmail, onNewChat }: Props) {
  const [activeId, setActiveId] = useState("chat");
  const initials = (userName ?? userEmail ?? "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-hairline bg-sidebar">
      <div className="flex items-center gap-2.5 px-3 py-3">
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
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-subtle"
        >
          <IconPlus />
          <span>New chat</span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {groups.map((group, gi) => (
          <div key={gi} className="py-1.5">
            {gi > 0 ? (
              <div className="mx-2 mb-1.5 h-px bg-hairline" aria-hidden />
            ) : null}
            {group.label ? (
              <div className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted">
                {group.label}
              </div>
            ) : null}
            <ul className="flex flex-col">
              {group.items.map((item) => {
                const active = item.id === activeId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(item.id)}
                      aria-current={active ? "page" : undefined}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
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

      <div className="border-t border-hairline px-3 py-2 text-[11px] text-muted">
        Week 1 build · Hardcoded auth
      </div>
    </aside>
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
