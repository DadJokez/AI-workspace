"use client";

import type { QueuedChatTurn } from "@/lib/chat-turn-queue";
import {
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

interface ChatTurnQueueProps {
  turns: QueuedChatTurn[];
  liveTurnSteeringSupported: boolean;
  onUpdate: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, offset: -1 | 1) => void;
  onApplyNow: (id: string) => void;
  onRetry: (id: string) => void;
  onEditingChange: (id: string | null) => void;
}

export function ChatTurnQueue({
  turns,
  liveTurnSteeringSupported,
  onUpdate,
  onRemove,
  onMove,
  onApplyNow,
  onRetry,
  onEditingChange,
}: ChatTurnQueueProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (turns.length === 0) {
      setNotice(null);
    }
    if (editingId && !turns.some((turn) => turn.id === editingId)) {
      setEditingId(null);
      onEditingChange(null);
    }
  }, [editingId, onEditingChange, turns]);

  if (turns.length === 0) return null;

  function beginEdit(turn: QueuedChatTurn) {
    setEditingId(turn.id);
    setDraft(turn.text);
    setNotice(null);
    onEditingChange(turn.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft("");
    onEditingChange(null);
  }

  function saveEdit() {
    if (!editingId || !draft.trim()) return;
    onUpdate(editingId, draft);
    cancelEdit();
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      saveEdit();
    }
  }

  function applyNow(turn: QueuedChatTurn) {
    onApplyNow(turn.id);
    setNotice(
      liveTurnSteeringSupported
        ? "Guidance will be applied to the active run."
        : "Live steering is not available for this run. This follow-up will send next.",
    );
  }

  return (
    <section
      aria-label="Queued follow-ups"
      data-testid="chat-turn-queue"
      className="mb-3 border-y border-hairline"
    >
      <div className="flex min-h-9 items-center justify-between gap-3 px-1 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-xs font-medium text-ink">Follow-ups</h2>
          <span className="text-2xs text-muted">
            {turns.length} {turns.length === 1 ? "turn" : "turns"}
          </span>
        </div>
        <span className="text-2xs text-muted">One at a time</span>
      </div>

      <ol className="border-t border-hairline">
        {turns.map((turn, index) => {
          const editing = editingId === turn.id;
          const locked = turn.status === "sending";
          return (
            <li
              key={turn.id}
              data-testid="queued-turn"
              className="border-b border-hairline px-1 py-2 last:border-b-0"
            >
              {editing ? (
                <div className="flex items-end gap-2">
                  <textarea
                    autoFocus
                    aria-label="Edit queued follow-up"
                    value={draft}
                    rows={2}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleEditKeyDown}
                    className="min-h-16 min-w-0 flex-1 resize-y rounded border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink outline-none focus:border-ink/50"
                  />
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={cancelEdit}
                      className="h-7 px-2 text-xs text-muted hover:text-ink"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!draft.trim()}
                      onClick={saveEdit}
                      className="h-7 rounded bg-pop px-2 text-xs text-on-pop disabled:opacity-30"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="w-5 shrink-0 text-right font-mono text-2xs text-muted"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{turn.text}</p>
                    {turn.status !== "queued" || turn.error ? (
                      <p
                        className={`mt-0.5 text-2xs ${
                          turn.status === "failed" ? "text-danger" : "text-muted"
                        }`}
                      >
                        {turn.status === "sending"
                          ? "Sending..."
                          : turn.error ?? "Waiting"}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {turn.status === "failed" ? (
                      <IconButton
                        label={`Retry ${turn.text}`}
                        title="Retry"
                        onClick={() => onRetry(turn.id)}
                      >
                        <RetryIcon />
                      </IconButton>
                    ) : null}
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => applyNow(turn)}
                      className="h-7 rounded px-2 text-xs text-muted hover:bg-subtle hover:text-ink disabled:opacity-30"
                    >
                      Apply now
                    </button>
                    <IconButton
                      label={`Move ${turn.text} up`}
                      title="Move up"
                      disabled={locked || index === 0}
                      onClick={() => onMove(turn.id, -1)}
                    >
                      <UpIcon />
                    </IconButton>
                    <IconButton
                      label={`Move ${turn.text} down`}
                      title="Move down"
                      disabled={locked || index === turns.length - 1}
                      onClick={() => onMove(turn.id, 1)}
                    >
                      <DownIcon />
                    </IconButton>
                    <IconButton
                      label={`Edit ${turn.text}`}
                      title="Edit"
                      disabled={locked}
                      onClick={() => beginEdit(turn)}
                    >
                      <EditIcon />
                    </IconButton>
                    <IconButton
                      label={`Delete ${turn.text}`}
                      title="Delete"
                      disabled={locked}
                      onClick={() => onRemove(turn.id)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {notice ? (
        <p role="status" className="border-t border-hairline px-1 py-2 text-xs text-muted">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

function IconButton({
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-subtle hover:text-ink disabled:opacity-25"
    >
      {children}
    </button>
  );
}

function UpIcon() {
  return <PathIcon path="M4 9 8 5l4 4M8 5v7" />;
}

function DownIcon() {
  return <PathIcon path="m4 7 4 4 4-4M8 11V4" />;
}

function RetryIcon() {
  return <PathIcon path="M12.5 5.5A5 5 0 1 0 13 9M12.5 2.5v3h-3" />;
}

function EditIcon() {
  return <PathIcon path="m10.8 2.7 2.5 2.5-7.7 7.7-3.1.6.6-3.1 7.7-7.7Z" />;
}

function DeleteIcon() {
  return <PathIcon path="M3.5 4.5h9M6 4.5v-2h4v2m1.5 0-.5 9H5l-.5-9M6.5 7v4M9.5 7v4" />;
}

function PathIcon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
