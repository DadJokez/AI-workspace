"use client";

import type {
  WorkspaceArtifactDetail,
  WorkspaceArtifactSummary,
} from "@/lib/workspace-artifacts";
import { useEffect, useMemo, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  artifact: WorkspaceArtifactSummary;
  widthPx: number;
  onWidthChange: (widthPx: number) => void;
  onClose: () => void;
}

interface ArtifactDetailResponse {
  artifact: WorkspaceArtifactDetail;
}

const MIN_PREVIEW_WIDTH = 360;
const MAX_PREVIEW_WIDTH = 960;
const MIN_CHAT_WIDTH = 420;

export function ArtifactPreviewPane({
  artifact,
  widthPx,
  onWidthChange,
  onClose,
}: Props) {
  const [detail, setDetail] = useState<WorkspaceArtifactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setDetail(null);

    fetch(`/api/workspace/artifacts/${artifact.id}`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<ArtifactDetailResponse>)
          : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data) => {
        if (!cancelled) setDetail(data.artifact);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const activeArtifact = detail ?? artifact;
  const content = detail ? displayContent(detail) : "";
  const previewKind = useMemo(
    () => detectPreviewKind(activeArtifact, content),
    [activeArtifact, content],
  );
  const previewStyle = {
    "--artifact-preview-width": `${widthPx}px`,
  } as CSSProperties;

  function clampPreviewWidth(next: number) {
    const maxByViewport = Math.max(
      MIN_PREVIEW_WIDTH,
      window.innerWidth - MIN_CHAT_WIDTH,
    );
    const maxWidth = Math.min(MAX_PREVIEW_WIDTH, maxByViewport);
    return Math.min(maxWidth, Math.max(MIN_PREVIEW_WIDTH, next));
  }

  function startResize(e: ReactPointerEvent<HTMLElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthPx;

    const handleMove = (move: PointerEvent) => {
      onWidthChange(clampPreviewWidth(startWidth + startX - move.clientX));
    };

    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function handleResizeKey(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 80 : 24;
    onWidthChange(
      clampPreviewWidth(widthPx + (e.key === "ArrowLeft" ? step : -step)),
    );
  }

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
      />
      <aside
        aria-label="Artifact preview"
        style={previewStyle}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-hairline bg-canvas text-ink shadow-2xl md:static md:z-auto md:h-full md:w-[var(--artifact-preview-width)] md:max-w-none md:shrink-0 md:shadow-none"
      >
        <div
          role="separator"
          aria-label="Resize artifact preview"
          aria-orientation="vertical"
          aria-valuemin={MIN_PREVIEW_WIDTH}
          aria-valuemax={MAX_PREVIEW_WIDTH}
          aria-valuenow={Math.round(widthPx)}
          data-testid="artifact-preview-resizer"
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={handleResizeKey}
          className="absolute left-0 top-0 hidden h-full w-2 -translate-x-1 cursor-col-resize touch-none border-0 bg-transparent p-0 md:block"
        >
          <span className="mx-auto block h-full w-px bg-hairline transition-colors hover:bg-ink/40" />
        </div>
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <span className="flex h-7 min-w-7 items-center justify-center rounded-full border border-[#67a3ff]/60 bg-[linear-gradient(135deg,#0637cf_0%,#095cff_54%,#00a6ff_100%)] px-2 font-mono text-[10px] uppercase text-white shadow-[0_0_18px_rgba(0,92,255,0.28)]">
            {activeArtifact.kind.slice(0, 4)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-ink">
              {activeArtifact.title}
            </h2>
            <p className="truncate text-[11px] text-muted">
              {activeArtifact.filename} · {formatBytes(activeArtifact.sizeBytes)}
            </p>
          </div>
          <a
            href={activeArtifact.downloadUrl}
            className="rounded-md border border-hairline px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle"
          >
            Download
          </a>
          <a
            href={activeArtifact.previewUrl}
            className="hidden rounded-md border border-hairline px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-subtle sm:inline"
          >
            Full page
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-canvas">
          {loading ? (
            <div className="flex h-full items-center justify-center text-[13px] text-muted">
              Loading preview...
            </div>
          ) : error ? (
            <div className="m-4 rounded-md border border-red-500/25 bg-red-500/5 px-3 py-2 text-[13px] text-red-300">
              {error}
            </div>
          ) : previewKind === "image" && detail ? (
            <div className="flex min-h-full items-center justify-center bg-black/20 p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- Artifact images are user-uploaded data URLs, not optimizable remote assets. */}
              <img
                src={imageDataUrl(detail)}
                alt={activeArtifact.title}
                className="max-h-full max-w-full rounded-md object-contain"
              />
            </div>
          ) : previewKind === "html" ? (
            <iframe
              title={activeArtifact.title}
              sandbox="allow-scripts allow-forms"
              srcDoc={content}
              className="h-full min-h-[720px] w-full border-0 bg-white"
            />
          ) : previewKind === "markdown" ? (
            <div className="prose prose-invert max-w-none px-4 py-4 text-[14px] leading-relaxed text-ink prose-headings:text-ink prose-a:text-ink">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
              </ReactMarkdown>
            </div>
          ) : (
            <pre className="min-h-full whitespace-pre-wrap px-4 py-4 font-mono text-[12px] leading-relaxed text-ink [overflow-wrap:anywhere]">
              {content}
            </pre>
          )}
        </div>
      </aside>
    </>
  );
}

function detectPreviewKind(
  artifact: WorkspaceArtifactSummary | WorkspaceArtifactDetail,
  content: string,
): "html" | "markdown" | "image" | "text" {
  const filename = artifact.filename.toLowerCase();
  const mimeType = artifact.mimeType.toLowerCase();
  if (mimeType.startsWith("image/")) return "image";
  if (
    mimeType.includes("html") ||
    filename.endsWith(".html") ||
    /<!doctype\s+html|<html[\s>]/i.test(content)
  ) {
    return "html";
  }
  if (
    mimeType.includes("markdown") ||
    filename.endsWith(".md") ||
    filename.endsWith(".markdown")
  ) {
    return "markdown";
  }
  return "text";
}

function displayContent(artifact: WorkspaceArtifactDetail): string {
  if (artifact.metadata?.storageEncoding === "base64") {
    const extracted = artifact.metadata.extractedText;
    return typeof extracted === "string" ? extracted : "";
  }
  return artifact.content;
}

function imageDataUrl(artifact: WorkspaceArtifactDetail): string {
  return `data:${artifact.mimeType};base64,${artifact.content}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
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
