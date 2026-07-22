"use client";

import Image from "next/image";
import { useState } from "react";
import { StatusBadge } from "@/app/admin/ui";
import { getLinkedIssueTag } from "./issue-tags";
import { EmptyState } from "@/components/EmptyState";
import { FEEDBACK_STATUS_OPTIONS } from "./feedback-status";

export interface AdminFeedbackRow {
  id: string;
  userEmail: string | null;
  userName: string | null;
  threadTitle: string | null;
  type: string;
  severity: string;
  status: string;
  title: string;
  body: string;
  expected: string | null;
  pageUrl: string | null;
  userAgent: string | null;
  screenshotName: string | null;
  screenshotMimeType: string | null;
  linkedIssueUrl: string | null;
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

const SAFE_SCREENSHOT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function safeExternalHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function hasSafeScreenshotMetadata(row: AdminFeedbackRow): boolean {
  return Boolean(
    row.screenshotName &&
      row.screenshotMimeType &&
      SAFE_SCREENSHOT_MIME_TYPES.has(row.screenshotMimeType.toLowerCase()),
  );
}

function isSafeScreenshotDataUrl(dataUrl: string, mimeType: string): boolean {
  const match = /^data:([^;,]+);base64,/i.exec(dataUrl);
  const dataUrlMimeType = match?.[1]?.toLowerCase();
  const normalizedMimeType = mimeType.toLowerCase();
  return (
    dataUrlMimeType === normalizedMimeType &&
    SAFE_SCREENSHOT_MIME_TYPES.has(dataUrlMimeType)
  );
}

export function FeedbackTable({ rows }: { rows: AdminFeedbackRow[] }) {
  const [items, setItems] = useState(rows);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function patchReport(
    id: string,
    patch: Partial<Pick<AdminFeedbackRow, "status" | "adminNotes" | "linkedIssueUrl">>,
  ) {
    setSavingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as {
        report?: Partial<AdminFeedbackRow>;
        error?: string;
      };
      if (!res.ok || !body.report) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, ...body.report } : item,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setSavingId(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="px-4 pb-10 sm:px-6">
        <EmptyState
          title="No feedback in this view"
          description="Try the full feedback history to see reports in another triage state."
          actionLabel="View all feedback"
          actionHref="/admin/feedback?status=all"
        />
      </div>
    );
  }

  return (
    <div className="px-4 pb-10 sm:px-6">
      {error ? (
        <div className="mb-3 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}
      <div className="grid gap-3 md:hidden">
        {items.map((row) => {
          const pageHref = safeExternalHref(row.pageUrl);
          const issueHref = safeExternalHref(row.linkedIssueUrl);
          const issueTag = getLinkedIssueTag(issueHref);
          const hasScreenshot = hasSafeScreenshotMetadata(row);
          return (
            <article
              key={row.id}
              className="rounded-lg border border-hairline bg-surface p-3 text-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h3 className="break-words font-medium text-ink">
                    {row.title}
                  </h3>
                  {issueHref ? (
                    <a
                      href={issueHref}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex rounded-full border border-cyan-400/35 bg-cyan-400/10 px-2 py-0.5 text-2xs font-medium text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-400/15"
                      title="Open linked GitHub item"
                    >
                      Reviewed {issueTag?.label ?? "GitHub"}
                    </a>
                  ) : null}
                </div>
                <StatusBadge status={row.severity} variant="outline" />
              </div>

              <div className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-ink/85">
                {row.body}
              </div>
              {row.expected ? (
                <div className="mt-2 text-xs text-muted">
                  Expected: <span className="text-ink/80">{row.expected}</span>
                </div>
              ) : null}

              <dl className="mt-3 grid gap-2 text-xs text-muted">
                <div>
                  <dt className="text-2xs uppercase tracking-wider text-muted/70">
                    Reporter
                  </dt>
                  <dd className="mt-0.5 break-words text-ink/85">
                    {row.userName ?? "Unknown"}
                    {row.userEmail ? (
                      <span className="text-muted"> · {row.userEmail}</span>
                    ) : null}
                  </dd>
                </div>
                {row.threadTitle ? (
                  <div>
                    <dt className="text-2xs uppercase tracking-wider text-muted/70">
                      Thread
                    </dt>
                    <dd className="mt-0.5 break-words text-ink/85">
                      {row.threadTitle}
                    </dd>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <span>{formatType(row.type)}</span>
                  <span>{new Date(row.createdAt).toLocaleString()}</span>
                  {pageHref ? (
                    <a
                      href={pageHref}
                      target="_blank"
                      rel="noreferrer"
                      className="text-ink underline decoration-hairline underline-offset-2"
                    >
                      Page
                    </a>
                  ) : null}
                </div>
                {row.screenshotName ? (
                  <div className="break-words">
                    Screenshot: {row.screenshotName}
                  </div>
                ) : null}
              </dl>

              <div className="mt-3">
                <label className="grid gap-1 text-xs text-muted">
                  <span>Status</span>
                  <StatusSelect
                    value={row.status}
                    disabled={savingId === row.id}
                    onChange={(status) => patchReport(row.id, { status })}
                    className="w-full"
                  />
                </label>
              </div>

              {hasScreenshot ? <ScreenshotPreview row={row} /> : null}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted hover:text-ink">
                  Triage notes
                </summary>
                <FeedbackNotesEditor
                  row={row}
                  saving={savingId === row.id}
                  onSave={(patch) => patchReport(row.id, patch)}
                />
              </details>
            </article>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-hairline bg-surface md:block">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-hairline text-2xs uppercase tracking-wider text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Report</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Severity</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const pageHref = safeExternalHref(row.pageUrl);
              const issueHref = safeExternalHref(row.linkedIssueUrl);
              const issueTag = getLinkedIssueTag(issueHref);
              const hasScreenshot = hasSafeScreenshotMetadata(row);
              return (
                <tr
                  key={row.id}
                  className="border-b border-hairline align-top last:border-0"
                >
                  <td className="max-w-xl px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-medium text-ink">{row.title}</div>
                      {issueHref ? (
                        <a
                          href={issueHref}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full border border-cyan-400/35 bg-cyan-400/10 px-2 py-0.5 text-2xs font-medium text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-400/15"
                          title="Open linked GitHub item"
                        >
                          Reviewed {issueTag?.label ?? "GitHub"}
                        </a>
                      ) : null}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink/85">
                      {row.body}
                    </div>
                    {row.expected ? (
                      <div className="mt-2 text-xs text-muted">
                        Expected:{" "}
                        <span className="text-ink/80">{row.expected}</span>
                      </div>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2 text-2xs text-muted">
                      <span>{formatType(row.type)}</span>
                      {row.threadTitle ? (
                        <span>Thread: {row.threadTitle}</span>
                      ) : null}
                      {pageHref ? (
                        <a
                          href={pageHref}
                          target="_blank"
                          rel="noreferrer"
                          className="text-ink underline decoration-hairline underline-offset-2"
                        >
                          Page
                        </a>
                      ) : null}
                      {row.screenshotName ? (
                        <span>Screenshot: {row.screenshotName}</span>
                      ) : null}
                      <span>{new Date(row.createdAt).toLocaleString()}</span>
                    </div>
                    {hasScreenshot ? <ScreenshotPreview row={row} /> : null}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-muted hover:text-ink">
                        Triage notes
                      </summary>
                      <FeedbackNotesEditor
                        row={row}
                        saving={savingId === row.id}
                        onSave={(patch) => patchReport(row.id, patch)}
                      />
                    </details>
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <div className="text-ink">{row.userName ?? "Unknown"}</div>
                    <div className="mt-0.5 text-muted">
                      {row.userEmail ?? "—"}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={row.severity} variant="outline" />
                  </td>
                  <td className="px-3 py-3">
                    <StatusSelect
                      value={row.status}
                      disabled={savingId === row.id}
                      onChange={(status) => patchReport(row.id, { status })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusSelect({
  value,
  disabled,
  onChange,
  className = "",
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`rounded-md border border-hairline bg-canvas px-2 py-1 text-xs text-ink focus-visible:border-ink/30 ${className}`}
    >
      {FEEDBACK_STATUS_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function ScreenshotPreview({ row }: { row: AdminFeedbackRow }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<{
    dataUrl: string;
    mimeType: string;
    name: string | null;
  } | null>(null);

  async function loadScreenshot() {
    if (loading || screenshot) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/feedback/${row.id}/screenshot`);
      const body = (await res.json().catch(() => ({}))) as {
        screenshot?: { dataUrl?: string; mimeType?: string; name?: string | null };
        error?: string;
      };
      const next = body.screenshot;
      if (
        !res.ok ||
        !next?.dataUrl ||
        !next.mimeType ||
        !isSafeScreenshotDataUrl(next.dataUrl, next.mimeType)
      ) {
        throw new Error(body.error ?? "Could not load screenshot.");
      }
      setScreenshot({
        dataUrl: next.dataUrl,
        mimeType: next.mimeType,
        name: next.name ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load screenshot.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="mt-2"
      onToggle={(e) => {
        if (e.currentTarget.open) void loadScreenshot();
      }}
    >
      <summary className="cursor-pointer text-xs text-muted hover:text-ink">
        Screenshot
      </summary>
      {loading ? (
        <div className="mt-2 rounded-md border border-hairline bg-canvas px-3 py-2 text-xs text-muted">
          Loading screenshot…
        </div>
      ) : error ? (
        <div className="mt-2 rounded-md border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : screenshot ? (
        <Image
          src={screenshot.dataUrl}
          alt={`Screenshot for ${row.title}`}
          width={720}
          height={405}
          unoptimized
          className="mt-2 h-auto max-h-72 max-w-full rounded-md border border-hairline object-contain"
        />
      ) : (
        <div className="mt-2 rounded-md border border-hairline bg-canvas px-3 py-2 text-xs text-muted">
          Expand to load {row.screenshotName ?? "screenshot"}.
        </div>
      )}
    </details>
  );
}

function FeedbackNotesEditor({
  row,
  saving,
  onSave,
}: {
  row: AdminFeedbackRow;
  saving: boolean;
  onSave: (
    patch: Partial<Pick<AdminFeedbackRow, "adminNotes" | "linkedIssueUrl">>,
  ) => void;
}) {
  const [adminNotes, setAdminNotes] = useState(row.adminNotes ?? "");
  const [linkedIssueUrl, setLinkedIssueUrl] = useState(row.linkedIssueUrl ?? "");

  return (
    <div className="mt-2 grid gap-2">
      <input
        value={linkedIssueUrl}
        onChange={(e) => setLinkedIssueUrl(e.target.value)}
        placeholder="GitHub issue URL"
        className="rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink focus-visible:border-ink/30"
      />
      <textarea
        value={adminNotes}
        onChange={(e) => setAdminNotes(e.target.value)}
        placeholder="Admin notes"
        rows={3}
        className="resize-y rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink focus-visible:border-ink/30"
      />
      <button
        type="button"
        disabled={saving}
        onClick={() => onSave({ adminNotes, linkedIssueUrl })}
        className="justify-self-start rounded-md border border-hairline bg-canvas px-2.5 py-1 text-xs font-medium text-ink hover:bg-subtle disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save notes"}
      </button>
    </div>
  );
}

function formatType(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
