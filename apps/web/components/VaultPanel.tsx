"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  userName?: string;
  onClose: () => void;
  onOpenSidebar: () => void;
}

interface MemoryItem {
  id: string;
  status: "suggested" | "approved" | "dismissed" | "archived";
  category: string;
  categoryLabel: string;
  title: string;
  bodyMd: string;
  confidence: number;
  reason: string | null;
  sourceThreadId: string | null;
  sourceMessageIds: string[];
  suggestedBy: string;
  approvedAt: string | null;
  dismissedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface VaultMemoryResponse {
  approvedMarkdown: string;
  approvedItems: MemoryItem[];
  suggestions: MemoryItem[];
}

interface EditDraft {
  category: string;
  title: string;
  bodyMd: string;
}

const MEMORY_CATEGORIES = [
  { value: "current_priorities", label: "Current Priorities" },
  { value: "projects", label: "Projects" },
  { value: "working_style", label: "Working Style" },
  { value: "communication", label: "Communication" },
  { value: "preferences", label: "Preferences" },
  { value: "systems", label: "Systems" },
  { value: "constraints", label: "Constraints" },
  { value: "decisions", label: "Decisions" },
  { value: "personal_context", label: "Personal Context" },
];

export function VaultPanel({
  userName,
  onClose,
  onOpenSidebar,
}: Props) {
  const [approvedMarkdown, setApprovedMarkdown] = useState("");
  const [approvedItems, setApprovedItems] = useState<MemoryItem[]>([]);
  const [suggestions, setSuggestions] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [actionPendingId, setActionPendingId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState<EditDraft>({
    category: "personal_context",
    title: "",
    bodyMd: "",
  });
  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addBody, setAddBody] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function addFact() {
    if (!addTitle.trim() || !addBody.trim()) return;
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await fetch("/api/vault/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: addTitle,
          bodyMd: addBody,
          category: "personal_context",
        }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (res.ok) {
        setAddTitle("");
        setAddBody("");
        setAddOpen(false);
        await loadVault();
        return;
      }
      setAddError(body.message ?? body.error ?? "Could not add the fact.");
    } catch {
      setAddError("Could not add the fact.");
    } finally {
      setAddBusy(false);
    }
  }

  async function loadVault() {
    setLoading(true);
    try {
      const res = await fetch("/api/vault/memory");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as VaultMemoryResponse;
      setApprovedMarkdown(data.approvedMarkdown ?? "");
      setApprovedItems(data.approvedItems ?? []);
      setSuggestions(data.suggestions ?? []);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadVault();
  }, []);

  function startEdit(item: MemoryItem) {
    setEditingId(item.id);
    setDraft({
      category: item.category,
      title: item.title,
      bodyMd: item.bodyMd,
    });
  }

  async function patchMemory(
    id: string,
    action: "approve" | "edit" | "dismiss" | "archive",
    edits?: Partial<EditDraft>,
  ) {
    setActionPendingId(id);
    try {
      const res = await fetch(`/api/vault/memory/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...edits }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingId(undefined);
      await loadVault();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPendingId(undefined);
    }
  }

  const owner = userName?.trim() || "User";

  return (
    <div className="flex h-full flex-col">
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
        <h1 className="flex-1 truncate px-2 text-sm font-medium text-ink">
          Vault
        </h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close vault"
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
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
          <section className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline pb-4">
            <div>
              <h2 className="text-base font-semibold text-ink">{owner}</h2>
              <p className="mt-1 text-[12px] text-muted">
                {approvedItems.length} approved · {suggestions.length} suggested
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadVault()}
              disabled={loading}
              className="rounded-md border border-hairline px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
            >
              Refresh
            </button>
          </section>

          {error ? (
            <div className="rounded-md border border-red-500/25 bg-red-500/5 px-3 py-2 text-[13px] text-red-300">
              {error}
            </div>
          ) : null}

          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">
                What the assistant remembers about you
              </h2>
              <button
                type="button"
                onClick={() => setAddOpen((v) => !v)}
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] text-ink hover:bg-subtle"
              >
                {addOpen ? "Cancel" : "Add a fact"}
              </button>
            </div>
            {addOpen ? (
              <div className="mb-3 flex flex-col gap-2 rounded-md border border-hairline p-3">
                <input
                  value={addTitle}
                  onChange={(e) => setAddTitle(e.target.value)}
                  placeholder="Short title (e.g. My team)"
                  maxLength={120}
                  className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-ink/30"
                />
                <textarea
                  value={addBody}
                  onChange={(e) => setAddBody(e.target.value)}
                  rows={3}
                  placeholder="The fact (e.g. I'm a supply-chain analyst on the Crossett team; I prefer concise, bulleted answers.)"
                  className="resize-y rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-ink/30"
                />
                {addError ? (
                  <p className="text-[12px] text-red-500">{addError}</p>
                ) : null}
                <button
                  type="button"
                  disabled={addBusy || !addTitle.trim() || !addBody.trim()}
                  onClick={addFact}
                  className="self-start rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas hover:opacity-90 disabled:opacity-50"
                >
                  {addBusy ? "Saving…" : "Save fact"}
                </button>
              </div>
            ) : null}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">Vault Markdown</h2>
            </div>
            <div className="min-h-40 rounded-lg border border-hairline bg-canvas px-4 py-3">
              {loading ? (
                <p className="text-[13px] text-muted">Loading Vault...</p>
              ) : approvedMarkdown.trim() ? (
                <div className="prose prose-sm max-w-none text-ink prose-headings:text-ink prose-p:text-ink prose-li:text-ink prose-strong:text-ink">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {approvedMarkdown}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="text-[13px] text-muted">
                  No approved Vault memory yet.
                </p>
              )}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">
                Suggested Updates
              </h2>
              <span className="text-[12px] text-muted">
                {suggestions.length}
              </span>
            </div>
            {loading ? (
              <div className="rounded-md border border-hairline px-4 py-6 text-center text-[13px] text-muted">
                Loading suggestions...
              </div>
            ) : suggestions.length === 0 ? (
              <div className="rounded-md border border-hairline px-4 py-6 text-center text-[13px] text-muted">
                No suggested updates.
              </div>
            ) : (
              <div className="grid gap-3">
                {suggestions.map((item) => (
                  <MemorySuggestionCard
                    key={item.id}
                    item={item}
                    editing={editingId === item.id}
                    draft={draft}
                    pending={actionPendingId === item.id}
                    onDraftChange={setDraft}
                    onEdit={() => startEdit(item)}
                    onCancelEdit={() => setEditingId(undefined)}
                    onApprove={() =>
                      void patchMemory(
                        item.id,
                        "approve",
                        editingId === item.id ? draft : undefined,
                      )
                    }
                    onDismiss={() => void patchMemory(item.id, "dismiss")}
                  />
                ))}
              </div>
            )}
          </section>

          {approvedItems.length > 0 ? (
            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-ink">
                  Approved Items
                </h2>
                <span className="text-[12px] text-muted">
                  {approvedItems.length}
                </span>
              </div>
              <div className="grid gap-2">
                {approvedItems.map((item) => (
                  <MemoryApprovedCard
                    key={item.id}
                    item={item}
                    editing={editingId === item.id}
                    draft={draft}
                    pending={actionPendingId === item.id}
                    onDraftChange={setDraft}
                    onEdit={() => startEdit(item)}
                    onCancelEdit={() => setEditingId(undefined)}
                    onSave={() =>
                      void patchMemory(item.id, "edit", draft)
                    }
                    onArchive={() => void patchMemory(item.id, "archive")}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MemoryApprovedCard({
  item,
  editing,
  draft,
  pending,
  onDraftChange,
  onEdit,
  onCancelEdit,
  onSave,
  onArchive,
}: {
  item: MemoryItem;
  editing: boolean;
  draft: EditDraft;
  pending: boolean;
  onDraftChange: (draft: EditDraft) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onArchive: () => void;
}) {
  return (
    <div
      data-testid="vault-approved-memory-card"
      className="rounded-md border border-hairline bg-canvas px-3 py-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted">
            {item.categoryLabel}
          </div>
          {editing ? (
            <div className="mt-2 grid gap-2">
              <select
                value={draft.category}
                onChange={(e) =>
                  onDraftChange({ ...draft, category: e.target.value })
                }
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
              >
                {MEMORY_CATEGORIES.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
              <input
                value={draft.title}
                onChange={(e) =>
                  onDraftChange({ ...draft, title: e.target.value })
                }
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
              />
              <textarea
                value={draft.bodyMd}
                onChange={(e) =>
                  onDraftChange({ ...draft, bodyMd: e.target.value })
                }
                rows={4}
                className="min-h-24 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] leading-relaxed text-ink"
              />
            </div>
          ) : (
            <>
              <h3 className="mt-1 text-[13px] font-medium text-ink">
                {item.title}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-muted [overflow-wrap:anywhere]">
                {item.bodyMd}
              </p>
            </>
          )}
          <MemoryEvidence item={item} />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={onSave}
                disabled={pending}
                className="rounded-md bg-ink px-2.5 py-1 text-[12px] font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={pending}
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                disabled={pending}
                className="rounded-md border border-hairline px-2 py-1 text-[12px] text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onArchive}
                disabled={pending}
                className="rounded-md border border-hairline px-2 py-1 text-[12px] text-muted hover:bg-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                Archive
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MemorySuggestionCard({
  item,
  editing,
  draft,
  pending,
  onDraftChange,
  onEdit,
  onCancelEdit,
  onApprove,
  onDismiss,
}: {
  item: MemoryItem;
  editing: boolean;
  draft: EditDraft;
  pending: boolean;
  onDraftChange: (draft: EditDraft) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-canvas p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
              {item.categoryLabel}
            </span>
            <span className="text-[11px] text-muted">
              Confidence {item.confidence}%
            </span>
          </div>
          {editing ? (
            <div className="mt-3 grid gap-2">
              <select
                value={draft.category}
                onChange={(e) =>
                  onDraftChange({ ...draft, category: e.target.value })
                }
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
              >
                {MEMORY_CATEGORIES.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
              <input
                value={draft.title}
                onChange={(e) =>
                  onDraftChange({ ...draft, title: e.target.value })
                }
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-ink"
              />
              <textarea
                value={draft.bodyMd}
                onChange={(e) =>
                  onDraftChange({ ...draft, bodyMd: e.target.value })
                }
                rows={4}
                className="min-h-24 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[13px] leading-relaxed text-ink"
              />
            </div>
          ) : (
            <>
              <h3 className="mt-3 text-[14px] font-semibold text-ink">
                {item.title}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink [overflow-wrap:anywhere]">
                {item.bodyMd}
              </p>
            </>
          )}
          {item.reason ? (
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              {item.reason}
            </p>
          ) : null}
          <MemoryEvidence item={item} prefix="Suggested" />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={onApprove}
                disabled={pending}
                className="rounded-md bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={pending}
                className="rounded-md border border-hairline px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onApprove}
                disabled={pending}
                className="rounded-md bg-ink px-3 py-1.5 text-[12px] font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={onEdit}
                disabled={pending}
                className="rounded-md border border-hairline px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onDismiss}
                disabled={pending}
                className="rounded-md border border-hairline px-3 py-1.5 text-[12px] font-medium text-muted hover:bg-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MemoryEvidence({
  item,
  prefix = "Updated",
}: {
  item: MemoryItem;
  prefix?: string;
}) {
  const sourceHref = item.sourceThreadId
    ? `/chat?threadId=${encodeURIComponent(item.sourceThreadId)}`
    : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
      <span>Confidence {item.confidence}%</span>
      <span>{prefix} {formatDate(prefix === "Suggested" ? item.createdAt : item.updatedAt)}</span>
      {sourceHref ? (
        <a
          href={sourceHref}
          className="rounded-sm underline decoration-hairline underline-offset-2 hover:text-ink"
        >
          Source thread
        </a>
      ) : (
        <span>Manual or imported memory</span>
      )}
      {item.sourceMessageIds.length > 0 ? (
        <span>
          {item.sourceMessageIds.length} source{" "}
          {item.sourceMessageIds.length === 1 ? "message" : "messages"}
        </span>
      ) : null}
      {item.reason ? (
        <span className="basis-full [overflow-wrap:anywhere]">
          Reason: {item.reason}
        </span>
      ) : null}
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
