"use client";

import { SlideOverPane } from "@/components/SlideOverPane";
import { fetchJson } from "@/lib/client-api";
import type {
  WorkspaceArtifactDetail,
  WorkspaceArtifactSummary,
} from "@/lib/workspace-artifacts";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  artifact: WorkspaceArtifactSummary;
  onClose: () => void;
}

interface ArtifactPreviewContentProps {
  artifact: WorkspaceArtifactSummary;
  onClose?: () => void;
}

interface ArtifactDetailResponse {
  artifact: WorkspaceArtifactDetail;
}

const MIN_PREVIEW_WIDTH = 360;
const MAX_PREVIEW_WIDTH = 960;

export function ArtifactPreviewPane({ artifact, onClose }: Props) {
  return (
    <SlideOverPane
      ariaLabel="Artifact preview"
      defaultWidth={640}
      minWidth={MIN_PREVIEW_WIDTH}
      maxWidth={MAX_PREVIEW_WIDTH}
      onClose={onClose}
      resizerLabel="Resize artifact preview"
      resizerTestId="artifact-preview-resizer"
      storageKey="comparative.slide-over.artifact.width"
    >
      <ArtifactPreviewContent artifact={artifact} onClose={onClose} />
    </SlideOverPane>
  );
}

export function ArtifactPreviewContent({
  artifact,
  onClose,
}: ArtifactPreviewContentProps) {
  const [detail, setDetail] = useState<WorkspaceArtifactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setDetail(null);

    fetchJson<ArtifactDetailResponse>(
      `/api/workspace/artifacts/${artifact.id}`,
      undefined,
      "Could not load the artifact preview.",
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

  const activeArtifact = detail ?? artifact;
  const content = detail ? displayContent(detail) : "";
  const previewKind = useMemo(
    () => detectPreviewKind(activeArtifact, content),
    [activeArtifact, content],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-12 shrink-0 touch-none items-center gap-2 border-b border-hairline px-3 md:touch-auto">
        <span className="flex h-7 min-w-7 items-center justify-center rounded-full border border-hairline bg-accent px-2 font-mono text-2xs uppercase text-on-accent">
          {activeArtifact.kind.slice(0, 4)}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-ink">
            {activeArtifact.title}
          </h2>
          <p className="truncate text-2xs text-muted">
            {activeArtifact.filename} · {formatBytes(activeArtifact.sizeBytes)}
          </p>
        </div>
        <a
          href={activeArtifact.downloadUrl}
          className="rounded-md border border-hairline px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-subtle"
        >
          Download
        </a>
        <a
          href={activeArtifact.previewUrl}
          className="hidden rounded-md border border-hairline px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-subtle sm:inline"
        >
          Full page
        </a>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
          >
            <CloseIcon />
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-canvas">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            Loading preview...
          </div>
        ) : error ? (
          <div className="m-4 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-sm text-danger">
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
          <div className="prose prose-invert max-w-none px-4 py-4 text-base leading-relaxed text-ink prose-headings:text-ink prose-a:text-ink">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className="min-h-full whitespace-pre-wrap px-4 py-4 font-mono text-xs leading-relaxed text-ink [overflow-wrap:anywhere]">
            {content}
          </pre>
        )}
      </div>
    </div>
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
