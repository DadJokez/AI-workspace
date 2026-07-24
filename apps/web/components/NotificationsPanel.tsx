"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { fetchJson } from "@/lib/client-api";
import { formatMonthDay } from "@/lib/format-date";

interface NotificationItem {
  id: string;
  type: "run_succeeded" | "run_failed";
  title: string;
  body: string | null;
  runId: string | null;
  threadId: string | null;
  readAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

interface DigestRun {
  id: string;
  status: string;
  skillName: string | null;
  skillSlug: string | null;
  threadId: string | null;
  error: string | null;
  completedAt: string | null;
}

interface DigestShare {
  id: string;
  subjectType: string;
  subjectName: string | null;
  grantedByName: string | null;
  createdAt: string;
}

interface Digest {
  since: string;
  completedRuns: DigestRun[];
  failedRuns: DigestRun[];
  newShares: DigestShare[];
}

interface Props {
  onClose: () => void;
  /** Deep-link into the thread a run's output landed in. */
  onOpenThread: (threadId: string, title: string) => void;
  /** Fired after any action that can change the unread count. */
  onUnreadChange?: (unreadCount: number) => void;
}

export function NotificationsPanel({
  onClose,
  onOpenThread,
  onUnreadChange,
}: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listBody, digestRes] = await Promise.all([
        fetchJson<{
          notifications: NotificationItem[];
          unreadCount: number;
        }>(
          "/api/notifications",
          undefined,
          "Could not load notifications.",
        ),
        fetch("/api/notifications/digest"),
      ]);
      setItems(listBody.notifications ?? []);
      onUnreadChange?.(listBody.unreadCount ?? 0);
      if (digestRes.ok) {
        const digestBody = (await digestRes.json()) as { digest: Digest };
        setDigest(digestBody.digest ?? null);
      }
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onUnreadChange]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(notification: NotificationItem) {
    // Optimistic: opening counts as read + accepted; the server records the
    // acceptance signal (first open wins).
    setItems((prev) =>
      prev.map((n) =>
        n.id === notification.id
          ? {
              ...n,
              readAt: n.readAt ?? new Date().toISOString(),
              acceptedAt: n.acceptedAt ?? new Date().toISOString(),
            }
          : n,
      ),
    );
    onUnreadChange?.(
      items.filter((n) => !n.readAt && n.id !== notification.id).length,
    );
    try {
      await fetch(`/api/notifications/${notification.id}/open`, {
        method: "POST",
      });
    } catch {
      // Non-fatal: the navigation is the user-visible action.
    }
    if (notification.threadId) {
      onOpenThread(notification.threadId, notification.title);
    }
  }

  async function markAllRead() {
    setItems((prev) =>
      prev.map((n) => ({
        ...n,
        readAt: n.readAt ?? new Date().toISOString(),
      })),
    );
    onUnreadChange?.(0);
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      // Refetch would correct any divergence on next open.
    }
  }

  const unread = items.filter((n) => !n.readAt).length;
  const digestHasContent =
    digest !== null &&
    digest.completedRuns.length +
      digest.failedRuns.length +
      digest.newShares.length >
      0;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 touch-none items-center gap-1 border-b border-hairline bg-canvas md:touch-auto">
        <h1 className="flex-1 truncate px-2 text-sm font-medium text-ink">
          Notifications
        </h1>
        {unread > 0 ? (
          <button
            type="button"
            onClick={markAllRead}
            data-testid="mark-all-read"
            className="mr-1 flex h-8 shrink-0 items-center rounded-md border border-hairline bg-canvas px-2 text-xs font-medium text-muted hover:bg-subtle hover:text-ink"
          >
            Mark all read
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notifications"
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

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
          {error ? (
            <p className="text-xs text-danger">
              Could not load notifications: {error}
            </p>
          ) : null}

          {digestHasContent ? (
            <section
              data-testid="daily-digest"
              className="flex flex-col gap-2"
            >
              <h2 className="text-2xs font-medium uppercase tracking-wider text-muted">
                Since you were last here
              </h2>
              <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-subtle/40 p-3">
                {digest!.completedRuns.map((run) => (
                  <DigestRow
                    key={run.id}
                    label={`${run.skillName ?? run.skillSlug ?? "Proactive run"} finished`}
                    tone="ok"
                    when={run.completedAt}
                    onClick={
                      run.threadId
                        ? () =>
                            onOpenThread(
                              run.threadId!,
                              run.skillName ?? "Proactive run",
                            )
                        : undefined
                    }
                  />
                ))}
                {digest!.failedRuns.map((run) => (
                  <DigestRow
                    key={run.id}
                    label={`${run.skillName ?? run.skillSlug ?? "Proactive run"} failed`}
                    tone="error"
                    when={run.completedAt}
                    onClick={
                      run.threadId
                        ? () =>
                            onOpenThread(
                              run.threadId!,
                              run.skillName ?? "Proactive run",
                            )
                        : undefined
                    }
                  />
                ))}
                {digest!.newShares.map((share) => (
                  <DigestRow
                    key={share.id}
                    label={`${share.grantedByName ?? "Someone"} shared ${
                      share.subjectType === "app" ? "an app" : "a skill"
                    }${share.subjectName ? `: ${share.subjectName}` : ""}`}
                    tone="ok"
                    when={share.createdAt}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-2">
            <h2 className="text-2xs font-medium uppercase tracking-wider text-muted">
              All notifications
            </h2>
            {loading ? (
              <p className="text-xs text-muted">Loading…</p>
            ) : items.length === 0 ? (
              <EmptyState
                title="No notifications yet"
                description="Scheduled and triggered runs that finish while you're away will land here."
                actionLabel="Refresh"
                onAction={() => void load()}
              />
            ) : (
              <ul className="flex flex-col" data-testid="notification-list">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => void open(n)}
                      data-testid={`notification-${n.id}`}
                      className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left hover:bg-subtle"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 block h-2 w-2 shrink-0 rounded-full ${
                          n.readAt
                            ? "bg-transparent"
                            : n.type === "run_failed"
                              ? "bg-danger"
                              : "bg-accent"
                        }`}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span
                          className={`truncate text-sm ${
                            n.readAt
                              ? "font-normal text-muted"
                              : "font-medium text-ink"
                          } ${n.type === "run_failed" ? "text-danger" : ""}`}
                        >
                          {n.title}
                        </span>
                        {n.body ? (
                          <span className="line-clamp-2 text-xs text-muted">
                            {n.body}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 shrink-0 text-2xs text-muted">
                        {relativeTime(n.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function DigestRow({
  label,
  tone,
  when,
  onClick,
}: {
  label: string;
  tone: "ok" | "error";
  when: string | null;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span
        aria-hidden="true"
        className={`block h-1.5 w-1.5 shrink-0 rounded-full ${
          tone === "error" ? "bg-danger" : "bg-accent"
        }`}
      />
      <span
        className={`min-w-0 flex-1 truncate text-xs ${
          tone === "error" ? "text-danger" : "text-ink"
        }`}
      >
        {label}
      </span>
      {when ? (
        <span className="shrink-0 text-2xs text-muted">
          {relativeTime(when)}
        </span>
      ) : null}
    </>
  );
  if (!onClick) {
    return <div className="flex items-center gap-2 px-1 py-1">{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-subtle"
    >
      {inner}
    </button>
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
  return formatMonthDay(ts);
}
