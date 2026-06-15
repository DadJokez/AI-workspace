"use client";

import { useEffect, useRef, useState } from "react";

export interface FeedbackContext {
  threadId?: string;
  threadTitle?: string;
  messageId?: string;
  messagePreview?: string;
  runId?: string;
  artifactId?: string;
  artifactTitle?: string;
}

interface Props {
  open: boolean;
  context?: FeedbackContext;
  onClose: () => void;
}

const MAX_SCREENSHOT_BYTES = 1_100_000;

export function FeedbackReporter({ open, context, onClose }: Props) {
  const [type, setType] = useState("bug");
  const [severity, setSeverity] = useState("normal");
  const [body, setBody] = useState("");
  const [expected, setExpected] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [screenshot, setScreenshot] = useState<{
    dataUrl: string;
    name: string;
    mimeType: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSentId(null);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  async function readScreenshot(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Screenshot must be an image file.");
      return;
    }
    if (file.size > MAX_SCREENSHOT_BYTES) {
      setError("Screenshot is too large. Keep it under 1 MB.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Could not read screenshot."));
      reader.readAsDataURL(file);
    });
    setError(null);
    setScreenshot({ dataUrl, name: file.name, mimeType: file.type });
  }

  async function submit() {
    const trimmed = body.trim();
    if (!trimmed) {
      setError("Tell us what went wrong first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          severity,
          body: trimmed,
          expected: expected.trim() || undefined,
          includeContext,
          context: includeContext ? context : undefined,
          pageUrl: typeof window !== "undefined" ? window.location.href : undefined,
          userAgent:
            typeof window !== "undefined" ? window.navigator.userAgent : undefined,
          viewport:
            typeof window !== "undefined"
              ? { width: window.innerWidth, height: window.innerHeight }
              : undefined,
          screenshotDataUrl: screenshot?.dataUrl,
          screenshotName: screenshot?.name,
          screenshotMimeType: screenshot?.mimeType,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        report?: { id: string };
        error?: string;
      };
      if (!res.ok || !payload.report?.id) {
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      setSentId(payload.report.id);
      setBody("");
      setExpected("");
      setScreenshot(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send feedback.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 px-4 py-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <div>
            <h2 id="feedback-title" className="text-sm font-semibold text-ink">
              Report feedback
            </h2>
            <p className="mt-0.5 text-[12px] text-muted">
              Send the issue with enough context for us to reproduce it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close feedback"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
          >
            <CloseIcon />
          </button>
        </div>

        {sentId ? (
          <div className="grid gap-3 px-4 py-5">
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[13px] text-emerald-100">
              Feedback sent. Report {sentId.slice(0, 8)} is in the admin inbox.
            </div>
            <button
              type="button"
              onClick={onClose}
              className="justify-self-end rounded-md border border-hairline bg-canvas px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-subtle"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="grid gap-3 overflow-y-auto px-4 py-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-[12px] font-medium text-muted">
                  Type
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="rounded-md border border-hairline bg-canvas px-2 py-2 text-[13px] text-ink outline-none focus:border-ink/30"
                  >
                    <option value="bug">Bug</option>
                    <option value="confusing_answer">Confusing answer</option>
                    <option value="missing_feature">Missing feature</option>
                    <option value="performance">Performance</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="grid gap-1 text-[12px] font-medium text-muted">
                  Severity
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value)}
                    className="rounded-md border border-hairline bg-canvas px-2 py-2 text-[13px] text-ink outline-none focus:border-ink/30"
                  >
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="low">Low</option>
                  </select>
                </label>
              </div>

              <label className="grid gap-1 text-[12px] font-medium text-muted">
                What happened
                <textarea
                  ref={textareaRef}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  maxLength={4000}
                  className="resize-y rounded-md border border-hairline bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-ink/30"
                />
              </label>

              <label className="grid gap-1 text-[12px] font-medium text-muted">
                Expected behavior
                <textarea
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  className="resize-y rounded-md border border-hairline bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-ink/30"
                />
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-[13px] text-ink">
                  <input
                    type="checkbox"
                    checked={includeContext}
                    onChange={(e) => setIncludeContext(e.target.checked)}
                    className="h-4 w-4 accent-ink"
                  />
                  Include current chat context
                </label>
                {context?.threadTitle ? (
                  <span className="min-w-0 truncate text-[12px] text-muted">
                    {context.threadTitle}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="cursor-pointer rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle">
                  Attach screenshot
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void readScreenshot(file);
                    }}
                  />
                </label>
                {screenshot ? (
                  <button
                    type="button"
                    onClick={() => setScreenshot(null)}
                    className="rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-muted hover:bg-subtle hover:text-ink"
                  >
                    {screenshot.name} · remove
                  </button>
                ) : null}
              </div>

              {error ? (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-200">
                  {error}
                </div>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 border-t border-hairline px-4 py-3">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-md border border-hairline bg-canvas px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-subtle disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="rounded-md border border-ink bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Send feedback"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
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
  );
}
