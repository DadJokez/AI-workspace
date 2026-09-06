"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { EmptyState } from "@/components/EmptyState";
import { fetchJson } from "@/lib/client-api";
import { formatDateTime as formatDate } from "@/lib/format-date";

interface Props {
  userName?: string;
  focusItemId?: string;
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
  provenance: "user_stated" | "user_cited" | "unverified";
  suggestedBy: string;
  approvedAt: string | null;
  dismissedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Organization standing instructions (#438): read by everyone, edited by
 * admins. Their own table and routes — never Vault rows.
 */
interface OrgInstruction {
  id: string;
  content: string;
  updatedAt: string;
}

interface OrgInstructionsResponse {
  approvedMarkdown: string;
  items: OrgInstruction[];
  canEdit: boolean;
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

export function MemorySettings({ userName, focusItemId }: Props) {
  const [approvedMarkdown, setApprovedMarkdown] = useState("");
  const [approvedItems, setApprovedItems] = useState<MemoryItem[]>([]);
  const [suggestions, setSuggestions] = useState<MemoryItem[]>([]);
  const [org, setOrg] = useState<OrgInstructionsResponse | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgAddOpen, setOrgAddOpen] = useState(false);
  const [orgAddDraft, setOrgAddDraft] = useState("");
  const [orgEditingId, setOrgEditingId] = useState<string>();
  const [orgEditDraft, setOrgEditDraft] = useState("");
  const [orgPendingId, setOrgPendingId] = useState<string>();
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
      await fetchJson(
        "/api/vault/memory",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: addTitle,
            bodyMd: addBody,
            category: "personal_context",
          }),
        },
        "Could not add the fact.",
      );
      setAddTitle("");
      setAddBody("");
      setAddOpen(false);
      await loadVault();
    } catch (err) {
      setAddError(
        err instanceof Error ? err.message : "Could not add the fact.",
      );
    } finally {
      setAddBusy(false);
    }
  }

  async function loadVault() {
    setLoading(true);
    try {
      const data = await fetchJson<VaultMemoryResponse>(
        "/api/vault/memory",
        undefined,
        "Could not load memory.",
      );
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

  async function loadOrgInstructions() {
    try {
      const data = await fetchJson<OrgInstructionsResponse>(
        "/api/org-instructions",
        undefined,
        "Could not load organization instructions.",
      );
      setOrg(data);
      setOrgError(null);
    } catch (err) {
      setOrgError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addOrgInstruction() {
    const content = orgAddDraft.trim();
    if (!content) return;
    setOrgPendingId("new");
    setOrgError(null);
    try {
      await fetchJson(
        "/api/org-instructions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        },
        "Could not add the instruction.",
      );
      setOrgAddDraft("");
      setOrgAddOpen(false);
      await loadOrgInstructions();
    } catch (err) {
      setOrgError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrgPendingId(undefined);
    }
  }

  async function patchOrgInstruction(id: string, action: "edit" | "archive") {
    setOrgPendingId(id);
    setOrgError(null);
    try {
      await fetchJson(
        `/api/org-instructions/${id}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            action === "edit" ? { action, content: orgEditDraft } : { action },
          ),
        },
        "Could not update the instruction.",
      );
      setOrgEditingId(undefined);
      await loadOrgInstructions();
    } catch (err) {
      setOrgError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrgPendingId(undefined);
    }
  }

  useEffect(() => {
    void loadVault();
    void loadOrgInstructions();
  }, []);

  useEffect(() => {
    if (loading || !focusItemId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`memory-item-${focusItemId}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusItemId, loading, approvedItems.length]);

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
      await fetchJson(
        `/api/vault/memory/${id}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...edits }),
        },
        "Could not update memory.",
      );
      setEditingId(undefined);
      await loadVault();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPendingId(undefined);
    }
  }

  const owner = userName?.trim() || "User";
  const nothingCaptured =
    !loading && approvedItems.length === 0 && suggestions.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline pb-4">
        <div>
          <h2 className="text-md font-semibold text-ink">Memory</h2>
          <p className="mt-1 text-sm text-muted">
            What Comparative has learned about {owner}.
          </p>
          <p className="mt-1 text-xs text-muted">
            {approvedItems.length} approved · {suggestions.length} suggested
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadVault()}
          disabled={loading}
          className="rounded-md border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          Refresh
        </button>
      </section>

      {error ? (
        <div className="rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {org ? (
        <section data-testid="vault-org-instructions">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                Organization standing instructions
              </h2>
              <p className="mt-0.5 text-xs text-muted">
                Admin-approved context every turn loads for everyone — above
                personal memory, below platform governance.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-muted">
                {org.items.length} approved
              </span>
              {org.canEdit ? (
                <button
                  type="button"
                  onClick={() => setOrgAddOpen((v) => !v)}
                  className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink hover:bg-subtle"
                >
                  {orgAddOpen ? "Cancel" : "Add instruction"}
                </button>
              ) : null}
            </div>
          </div>
          {orgError ? (
            <div className="mb-3 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-sm text-danger">
              {orgError}
            </div>
          ) : null}
          {orgAddOpen ? (
            <div className="mb-3 flex flex-col gap-2 rounded-md border border-hairline p-3">
              <textarea
                value={orgAddDraft}
                onChange={(e) => setOrgAddDraft(e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder="The instruction, as markdown (e.g. Always cite Salesforce record IDs when you mention an account.)"
                className="resize-y rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink placeholder:text-muted"
              />
              <button
                type="button"
                disabled={orgPendingId === "new" || !orgAddDraft.trim()}
                onClick={() => void addOrgInstruction()}
                className="self-start rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-50"
              >
                {orgPendingId === "new" ? "Saving…" : "Save instruction"}
              </button>
            </div>
          ) : null}
          <div className="rounded-lg border border-hairline bg-canvas px-4 py-3">
            {org.approvedMarkdown.trim() ? (
              <div className="prose prose-sm max-w-none text-ink prose-headings:text-ink prose-p:text-ink prose-li:text-ink prose-strong:text-ink">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {org.approvedMarkdown}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-muted">
                Not configured.
                {org.canEdit ? " Use “Add instruction” to write one." : ""}
              </p>
            )}
          </div>
          {org.canEdit && org.items.length > 0 ? (
            <div className="mt-2 grid gap-2">
              {org.items.map((item) => (
                <OrgInstructionCard
                  key={item.id}
                  item={item}
                  editing={orgEditingId === item.id}
                  draft={orgEditDraft}
                  pending={orgPendingId === item.id}
                  onDraftChange={setOrgEditDraft}
                  onEdit={() => {
                    setOrgEditingId(item.id);
                    setOrgEditDraft(item.content);
                  }}
                  onCancelEdit={() => setOrgEditingId(undefined)}
                  onSave={() => void patchOrgInstruction(item.id, "edit")}
                  onArchive={() => void patchOrgInstruction(item.id, "archive")}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {nothingCaptured && !addOpen ? (
        <EmptyState
          title="No memory yet"
          description="Add a fact, or keep chatting and Comparative will suggest useful context for your approval."
          actionLabel="Add a fact"
          onAction={() => setAddOpen(true)}
        />
      ) : null}

      {!nothingCaptured || addOpen ? (
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">
              What the assistant remembers about you
            </h2>
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink hover:bg-subtle"
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
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink placeholder:text-muted"
              />
              <textarea
                value={addBody}
                onChange={(e) => setAddBody(e.target.value)}
                rows={3}
                placeholder="The fact (e.g. I'm a supply-chain analyst on the Crossett team; I prefer concise, bulleted answers.)"
                className="resize-y rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink placeholder:text-muted"
              />
              {addError ? (
                <p className="text-xs text-danger">{addError}</p>
              ) : null}
              <button
                type="button"
                disabled={addBusy || !addTitle.trim() || !addBody.trim()}
                onClick={addFact}
                className="self-start rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-50"
              >
                {addBusy ? "Saving…" : "Save fact"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {!nothingCaptured ? (
        <>
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">
                Vault Markdown
              </h2>
            </div>
            <div className="min-h-40 rounded-lg border border-hairline bg-canvas px-4 py-3">
              {loading ? (
                <p className="text-sm text-muted">Loading Vault...</p>
              ) : approvedMarkdown.trim() ? (
                <div className="prose prose-sm max-w-none text-ink prose-headings:text-ink prose-p:text-ink prose-li:text-ink prose-strong:text-ink">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {approvedMarkdown}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-muted">
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
              <span className="text-xs text-muted">{suggestions.length}</span>
            </div>
            {loading ? (
              <div className="rounded-md border border-hairline px-4 py-6 text-center text-sm text-muted">
                Loading suggestions...
              </div>
            ) : suggestions.length === 0 ? (
              <div className="rounded-md border border-hairline px-4 py-6 text-center text-sm text-muted">
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
                <span className="text-xs text-muted">
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
                    onSave={() => void patchMemory(item.id, "edit", draft)}
                    onArchive={() => void patchMemory(item.id, "archive")}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function OrgInstructionCard({
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
  item: OrgInstruction;
  editing: boolean;
  draft: string;
  pending: boolean;
  onDraftChange: (draft: string) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onArchive: () => void;
}) {
  return (
    <div
      data-testid="vault-org-instruction-card"
      className="rounded-md border border-hairline bg-canvas px-3 py-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              rows={4}
              maxLength={4000}
              className="min-h-24 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm leading-relaxed text-ink"
            />
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
              {item.content}
            </p>
          )}
          <p className="mt-2 text-2xs text-muted">
            Updated {formatDate(item.updatedAt)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={onSave}
                disabled={pending || !draft.trim()}
                className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={pending}
                className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
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
                className="rounded-md border border-hairline px-2 py-1 text-xs text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onArchive}
                disabled={pending}
                className="rounded-md border border-hairline px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
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
      id={`memory-item-${item.id}`}
      data-testid="vault-approved-memory-card"
      tabIndex={-1}
      className="rounded-md border border-hairline bg-canvas px-3 py-2 outline-none focus:border-ink/35 focus:ring-1 focus:ring-ink/15"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-medium uppercase tracking-wider text-muted">
            {item.categoryLabel}
          </div>
          {editing ? (
            <div className="mt-2 grid gap-2">
              <select
                value={draft.category}
                onChange={(e) =>
                  onDraftChange({ ...draft, category: e.target.value })
                }
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink"
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
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink"
              />
              <textarea
                value={draft.bodyMd}
                onChange={(e) =>
                  onDraftChange({ ...draft, bodyMd: e.target.value })
                }
                rows={4}
                className="min-h-24 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm leading-relaxed text-ink"
              />
            </div>
          ) : (
            <>
              <h3 className="mt-1 text-sm font-medium text-ink">
                {item.title}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
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
                className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Save
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={pending}
                className="rounded-md border border-hairline px-2.5 py-1 text-xs text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
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
                className="rounded-md border border-hairline px-2 py-1 text-xs text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onArchive}
                disabled={pending}
                className="rounded-md border border-hairline px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
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
    <div
      data-testid="vault-suggested-memory-card"
      className="rounded-lg border border-hairline bg-canvas p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-subtle px-2 py-0.5 text-2xs uppercase tracking-wider text-muted">
              {item.categoryLabel}
            </span>
            <span className="text-2xs text-muted">
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
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink"
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
                className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink"
              />
              <textarea
                value={draft.bodyMd}
                onChange={(e) =>
                  onDraftChange({ ...draft, bodyMd: e.target.value })
                }
                rows={4}
                className="min-h-24 rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm leading-relaxed text-ink"
              />
            </div>
          ) : (
            <>
              <h3 className="mt-3 text-base font-semibold text-ink">
                {item.title}
              </h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
                {item.bodyMd}
              </p>
            </>
          )}
          {item.reason ? (
            <p className="mt-2 text-xs leading-relaxed text-muted">
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
                className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={pending}
                className="rounded-md border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
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
                className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-canvas hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={onEdit}
                disabled={pending}
                className="rounded-md border border-hairline px-3 py-1.5 text-xs font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onDismiss}
                disabled={pending}
                className="rounded-md border border-hairline px-3 py-1.5 text-xs font-medium text-muted hover:bg-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
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
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
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
        <>
          <span>
            {item.provenance === "user_stated"
              ? "User-stated"
              : item.provenance === "user_cited"
                ? "Cites user message"
                : "Source role not verified"}
          </span>
          <span>
            {item.sourceMessageIds.length} source{" "}
            {item.sourceMessageIds.length === 1 ? "message" : "messages"}
          </span>
        </>
      ) : null}
      {item.reason ? (
        <span className="basis-full [overflow-wrap:anywhere]">
          Reason: {item.reason}
        </span>
      ) : null}
    </div>
  );
}
