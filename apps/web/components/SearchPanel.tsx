"use client";

import type { ThreadSummary } from "@/components/Sidebar";
import { useEffect, useMemo, useRef, useState } from "react";

type FilterKind = "all" | "chats" | "agents" | "apps";

interface Props {
  threads: ThreadSummary[];
  threadsLoading: boolean;
  onOpenThread: (threadId: string, title: string) => void;
  onClose: () => void;
  onOpenSidebar: () => void;
}

const FILTERS: ReadonlyArray<{ value: FilterKind; label: string }> = [
  { value: "all", label: "All" },
  { value: "chats", label: "Chats" },
  { value: "agents", label: "Agents" },
  { value: "apps", label: "Apps" },
];

export function SearchPanel({
  threads,
  threadsLoading,
  onOpenThread,
  onClose,
  onOpenSidebar,
}: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const isComingSoon = filter === "agents" || filter === "apps";
  const trimmed = query.trim();

  const results = useMemo(() => {
    if (isComingSoon) return [] as ThreadSummary[];
    const q = trimmed.toLowerCase();
    if (!q) return threads;
    return threads.filter((t) =>
      (t.title ?? "").toLowerCase().includes(q),
    );
  }, [threads, trimmed, isComingSoon]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline bg-canvas">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Open menu"
          className="flex h-11 w-11 shrink-0 items-center justify-center text-muted hover:bg-subtle hover:text-ink md:hidden"
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
        <div className="flex flex-1 items-center gap-2 px-2">
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
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
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            // Inline font-size beats every class-level rule. Sub-16px lets
            // iOS Safari (and Comet, which inherits the WebKit zoom rule) zoom
            // the page on focus.
            style={{ fontSize: "16px" }}
            className="flex-1 bg-transparent py-2 text-base text-ink outline-none placeholder:text-muted"
          />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="mr-2 flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
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
      </header>

      <div className="border-b border-hairline bg-canvas">
        <div className="mx-auto flex max-w-2xl gap-1 overflow-x-auto px-4 py-2 sm:px-6">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                aria-pressed={active}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
                  active
                    ? "border-ink bg-ink text-canvas"
                    : "border-hairline text-muted hover:bg-subtle hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-3 py-3 sm:px-6 sm:py-4">
          {isComingSoon ? (
            <ComingSoon kind={filter} />
          ) : threadsLoading && threads.length === 0 ? (
            <ResultsSkeleton />
          ) : results.length === 0 ? (
            <EmptyResults query={trimmed} hasThreads={threads.length > 0} />
          ) : (
            <ul className="flex flex-col">
              {results.map((t) => {
                const title = t.title?.trim() || "Untitled";
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onOpenThread(t.id, t.title ?? "")}
                      className="flex w-full min-h-[44px] items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-subtle md:min-h-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">
                        {title}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted">
                        {relativeTime(t.updatedAt)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ComingSoon({ kind }: { kind: FilterKind }) {
  const label = kind === "agents" ? "Agents" : "Apps";
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <div className="text-sm font-medium text-ink">{label} coming soon</div>
      <p className="max-w-sm text-[12px] text-muted">
        We&apos;ll surface {label.toLowerCase()} here once they&apos;re wired
        up. For now, search is limited to your conversations.
      </p>
    </div>
  );
}

function EmptyResults({
  query,
  hasThreads,
}: {
  query: string;
  hasThreads: boolean;
}) {
  if (!hasThreads) {
    return (
      <div className="py-16 text-center text-sm text-muted">
        No conversations yet. Start a chat to see it here.
      </div>
    );
  }
  if (query) {
    return (
      <div className="py-16 text-center text-sm text-muted">
        No conversations match &ldquo;{query}&rdquo;.
      </div>
    );
  }
  return (
    <div className="py-16 text-center text-sm text-muted">
      Nothing to show.
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <ul className="flex flex-col gap-1">
      {[0, 1, 2, 3, 4].map((i) => (
        <li
          key={i}
          className="h-9 animate-pulse rounded-md bg-subtle"
          aria-hidden
        />
      ))}
    </ul>
  );
}

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
