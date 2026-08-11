"use client";

import { Icon } from "@ai-workspace/umber/components/media/Icon";
import { fetchJson } from "@/lib/client-api";
import {
  computeArtifactLineDiff,
  type ArtifactLineDiff,
} from "@/lib/artifact-diff";
import type {
  WorkspaceArtifactDetail,
  WorkspaceArtifactSummary,
  WorkspaceArtifactVersionSet,
} from "@/lib/workspace-artifacts";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ArtifactPreviewContentProps {
  artifact: WorkspaceArtifactSummary;
  onClose?: () => void;
}

interface ArtifactDetailResponse {
  artifact: WorkspaceArtifactDetail;
}

type ArtifactReviewMode = "preview" | "source" | "compare";

interface ArtifactComparison {
  from: WorkspaceArtifactDetail;
  to: WorkspaceArtifactDetail;
}

export function ArtifactPreviewContent({
  artifact,
  onClose,
}: ArtifactPreviewContentProps) {
  const [detail, setDetail] = useState<WorkspaceArtifactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [reviewMode, setReviewMode] =
    useState<ArtifactReviewMode>("preview");
  const [versionSet, setVersionSet] =
    useState<WorkspaceArtifactVersionSet | null>(null);
  const [versionError, setVersionError] = useState<string | undefined>();
  const [fromVersionId, setFromVersionId] = useState<string>(artifact.id);
  const [toVersionId, setToVersionId] = useState<string>(artifact.id);
  const [comparison, setComparison] = useState<ArtifactComparison | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | undefined>();

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

  useEffect(() => {
    let cancelled = false;
    setReviewMode("preview");
    setVersionSet(null);
    setVersionError(undefined);
    setComparison(null);
    setComparisonError(undefined);
    setFromVersionId(artifact.id);
    setToVersionId(artifact.id);

    fetchJson<WorkspaceArtifactVersionSet>(
      `/api/workspace/artifacts/${artifact.id}/versions`,
      undefined,
      "Could not load artifact versions.",
    )
      .then((data) => {
        if (cancelled) return;
        setVersionSet(data);
        const selectedIndex = data.versions.findIndex(
          (version) => version.id === data.selectedArtifactId,
        );
        const previous =
          selectedIndex > 0
            ? data.versions[selectedIndex - 1]
            : data.versions[0];
        setFromVersionId(previous?.id ?? artifact.id);
        setToVersionId(data.selectedArtifactId);
      })
      .catch((err) => {
        if (!cancelled) {
          setVersionError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artifact.id]);

  useEffect(() => {
    if (reviewMode !== "compare" || !fromVersionId || !toVersionId) return;
    let cancelled = false;
    setComparisonLoading(true);
    setComparisonError(undefined);
    setComparison(null);

    Promise.all([
      loadArtifactDetail(fromVersionId),
      loadArtifactDetail(toVersionId),
    ])
      .then(([from, to]) => {
        if (!cancelled) setComparison({ from, to });
      })
      .catch((err) => {
        if (!cancelled) {
          setComparisonError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setComparisonLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fromVersionId, reviewMode, toVersionId]);

  const activeArtifact = detail ?? artifact;
  const content = detail ? displayContent(detail) : "";
  const previewKind = useMemo(
    () => detectPreviewKind(activeArtifact, content),
    [activeArtifact, content],
  );
  const sourceAvailable = isTextReviewFormat(activeArtifact);
  const compareAvailable = (versionSet?.versions.length ?? 0) > 1;
  const comparisonDiff = useMemo<ArtifactLineDiff | null>(() => {
    if (
      !comparison ||
      !isTextReviewFormat(comparison.from) ||
      !isTextReviewFormat(comparison.to)
    ) {
      return null;
    }
    return computeArtifactLineDiff(
      displayContent(comparison.from),
      displayContent(comparison.to),
    );
  }, [comparison]);

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
            title="Close preview"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
          >
            <Icon name="x" size={14} strokeWidth={1.6} />
          </button>
        ) : null}
      </header>

      <ArtifactReviewToolbar
        artifact={activeArtifact}
        mode={reviewMode}
        sourceAvailable={sourceAvailable}
        compareAvailable={compareAvailable}
        versionSet={versionSet}
        versionError={versionError}
        onModeChange={setReviewMode}
        onCompareLatest={() => {
          if (!versionSet) return;
          setFromVersionId(versionSet.selectedArtifactId);
          setToVersionId(versionSet.latestArtifactId);
          setReviewMode("compare");
        }}
      />

      <div
        id="artifact-review-panel"
        role="tabpanel"
        aria-labelledby={`artifact-review-tab-${reviewMode}`}
        className="min-h-0 flex-1 overflow-auto bg-canvas"
      >
        {reviewMode === "compare" ? (
          <ArtifactVersionComparison
            versionSet={versionSet}
            fromVersionId={fromVersionId}
            toVersionId={toVersionId}
            comparison={comparison}
            diff={comparisonDiff}
            loading={comparisonLoading}
            error={comparisonError}
            onFromVersionChange={setFromVersionId}
            onToVersionChange={setToVersionId}
          />
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            Loading preview...
          </div>
        ) : error ? (
          <div className="m-4 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </div>
        ) : reviewMode === "source" ? (
          <pre
            data-testid="artifact-source-view"
            className="min-h-full whitespace-pre-wrap px-4 py-4 font-mono text-xs leading-relaxed text-ink [overflow-wrap:anywhere]"
          >
            {content}
          </pre>
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

function ArtifactReviewToolbar({
  artifact,
  mode,
  sourceAvailable,
  compareAvailable,
  versionSet,
  versionError,
  onModeChange,
  onCompareLatest,
}: {
  artifact: WorkspaceArtifactSummary | WorkspaceArtifactDetail;
  mode: ArtifactReviewMode;
  sourceAvailable: boolean;
  compareAvailable: boolean;
  versionSet: WorkspaceArtifactVersionSet | null;
  versionError?: string;
  onModeChange: (mode: ArtifactReviewMode) => void;
  onCompareLatest: () => void;
}) {
  const modes: Array<{ id: ArtifactReviewMode; label: string }> = [
    { id: "preview", label: "Preview" },
    ...(sourceAvailable
      ? ([{ id: "source", label: "Source" }] as const)
      : []),
    ...(compareAvailable
      ? ([{ id: "compare", label: "Compare" }] as const)
      : []),
  ];
  const latest = versionSet?.versions.at(-1);

  return (
    <>
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1.5">
        <div
          role="tablist"
          aria-label="Artifact review mode"
          className="inline-flex rounded-md border border-hairline bg-subtle p-0.5"
        >
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`artifact-review-tab-${item.id}`}
              aria-controls="artifact-review-panel"
              aria-selected={mode === item.id}
              tabIndex={mode === item.id ? 0 : -1}
              onClick={() => onModeChange(item.id)}
              onKeyDown={(event) => {
                const nextIndex = nextReviewModeIndex(
                  modes,
                  mode,
                  event.key,
                );
                if (nextIndex === null) return;
                event.preventDefault();
                const nextMode = modes[nextIndex]!;
                onModeChange(nextMode.id);
                const tabs =
                  event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                    '[role="tab"]',
                  );
                tabs?.[nextIndex]?.focus();
              }}
              className={`h-7 rounded px-2.5 text-xs font-medium transition-colors ${
                mode === item.id
                  ? "bg-canvas text-ink shadow-sm"
                  : "text-muted hover:text-ink"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-2xs text-muted">
          v{artifact.versionNumber}
          {latest ? ` of ${latest.versionNumber}` : ""}
        </span>
        {versionError ? (
          <span
            className="max-w-full truncate text-2xs text-danger"
            title={versionError}
          >
            Version history unavailable
          </span>
        ) : null}
      </div>
      {versionSet?.staleBase ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning-bg px-3 py-2 text-xs text-ink"
        >
          <Icon name="alert-triangle" size={14} strokeWidth={1.6} />
          <span className="min-w-0 flex-1">
            You are reviewing v{artifact.versionNumber}; v
            {latest?.versionNumber ?? "?"} is now latest.
          </span>
          <button
            type="button"
            onClick={onCompareLatest}
            className="shrink-0 font-medium underline underline-offset-2 hover:text-muted"
          >
            Compare with latest
          </button>
        </div>
      ) : null}
    </>
  );
}

function nextReviewModeIndex(
  modes: readonly { id: ArtifactReviewMode }[],
  currentMode: ArtifactReviewMode,
  key: string,
): number | null {
  const currentIndex = modes.findIndex((item) => item.id === currentMode);
  if (key === "Home") return 0;
  if (key === "End") return modes.length - 1;
  if (key === "ArrowRight") return (currentIndex + 1) % modes.length;
  if (key === "ArrowLeft") {
    return (currentIndex - 1 + modes.length) % modes.length;
  }
  return null;
}

function ArtifactVersionComparison({
  versionSet,
  fromVersionId,
  toVersionId,
  comparison,
  diff,
  loading,
  error,
  onFromVersionChange,
  onToVersionChange,
}: {
  versionSet: WorkspaceArtifactVersionSet | null;
  fromVersionId: string;
  toVersionId: string;
  comparison: ArtifactComparison | null;
  diff: ArtifactLineDiff | null;
  loading: boolean;
  error?: string;
  onFromVersionChange: (id: string) => void;
  onToVersionChange: (id: string) => void;
}) {
  if (!versionSet) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-muted">
        Version history is unavailable for this artifact.
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col" data-testid="artifact-version-comparison">
      <div className="flex flex-wrap items-end gap-2 border-b border-hairline px-3 py-2">
        <VersionSelect
          label="From"
          value={fromVersionId}
          versions={versionSet.versions}
          onChange={onFromVersionChange}
        />
        <Icon
          name="arrow-right"
          size={15}
          strokeWidth={1.6}
          className="mb-2 hidden text-muted sm:block"
        />
        <VersionSelect
          label="To"
          value={toVersionId}
          versions={versionSet.versions}
          onChange={onToVersionChange}
        />
      </div>
      {loading ? (
        <div className="flex flex-1 items-center justify-center px-4 py-12 text-sm text-muted">
          Comparing versions...
        </div>
      ) : error ? (
        <div className="m-4 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : !comparison ? null : diff ? (
        <ArtifactLineDiffView
          diff={diff}
          from={comparison.from}
          to={comparison.to}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
          <p className="text-sm font-medium text-ink">
            Rendered comparison is not available for this format.
          </p>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-muted">
            Comparative kept both immutable versions. Open each preview to review
            images, PDFs, and Office files without pretending a text diff is
            meaningful.
          </p>
        </div>
      )}
    </div>
  );
}

function VersionSelect({
  label,
  value,
  versions,
  onChange,
}: {
  label: string;
  value: string;
  versions: readonly WorkspaceArtifactSummary[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="min-w-0 flex-1 sm:max-w-64">
      <span className="mb-1 block font-mono text-2xs uppercase text-muted">
        {label}
      </span>
      <select
        aria-label={`${label} version`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-hairline bg-canvas px-2 text-xs text-ink outline-none focus:border-muted"
      >
        {versions.map((version) => (
          <option key={version.id} value={version.id}>
            v{version.versionNumber} · {formatShortDate(version.createdAt)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ArtifactLineDiffView({
  diff,
  from,
  to,
}: {
  diff: ArtifactLineDiff;
  from: WorkspaceArtifactDetail;
  to: WorkspaceArtifactDetail;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-hairline bg-canvas px-3 py-2 text-xs">
        <span className="font-medium text-ink">
          v{from.versionNumber} to v{to.versionNumber}
        </span>
        <span className="text-success">+{diff.added}</span>
        <span className="text-danger">-{diff.removed}</span>
        {diff.approximate ? (
          <span className="text-muted">
            Coarse comparison for a large document
          </span>
        ) : null}
        {diff.truncated ? (
          <span className="text-muted">Long diff truncated for display</span>
        ) : null}
      </div>
      <div className="min-w-full font-mono text-xs leading-5">
        {diff.added === 0 && diff.removed === 0 ? (
          <div className="px-4 py-12 text-center font-sans text-sm text-muted">
            No differences between these versions.
          </div>
        ) : (
          diff.entries.map((entry, index) => {
            if (entry.kind === "omitted") {
              return (
                <div
                  key={`omitted-${index}`}
                  className="border-y border-hairline bg-subtle px-3 py-1 text-center text-2xs text-muted"
                >
                  {entry.omissionReason === "truncated"
                    ? "Diff display truncated"
                    : `${entry.omittedLines ?? 0} unchanged lines hidden`}
                </div>
              );
            }
            const tone =
              entry.kind === "added"
                ? "bg-success-bg"
                : entry.kind === "removed"
                  ? "bg-danger-bg"
                  : "";
            return (
              <div
                key={`${entry.kind}-${index}`}
                className={`flex min-w-max ${tone}`}
              >
                <span className="w-12 shrink-0 select-none border-r border-hairline px-2 text-right text-muted">
                  {entry.previousLine ?? ""}
                </span>
                <span className="w-12 shrink-0 select-none border-r border-hairline px-2 text-right text-muted">
                  {entry.nextLine ?? ""}
                </span>
                <span
                  className={`w-6 shrink-0 select-none text-center ${
                    entry.kind === "added"
                      ? "text-success"
                      : entry.kind === "removed"
                        ? "text-danger"
                        : "text-muted"
                  }`}
                >
                  {entry.kind === "added"
                    ? "+"
                    : entry.kind === "removed"
                      ? "-"
                      : " "}
                </span>
                <code className="min-w-0 flex-1 whitespace-pre-wrap pr-3 text-ink [overflow-wrap:anywhere]">
                  {entry.text || " "}
                </code>
              </div>
            );
          })
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

function isTextReviewFormat(
  artifact: WorkspaceArtifactSummary | WorkspaceArtifactDetail,
): boolean {
  const filename = artifact.filename.toLowerCase();
  const mimeType = artifact.mimeType.toLowerCase();
  return (
    mimeType.startsWith("text/") ||
    mimeType.includes("json") ||
    filename.endsWith(".md") ||
    filename.endsWith(".markdown") ||
    filename.endsWith(".txt") ||
    filename.endsWith(".html") ||
    filename.endsWith(".htm") ||
    filename.endsWith(".json")
  );
}

async function loadArtifactDetail(
  artifactId: string,
): Promise<WorkspaceArtifactDetail> {
  const response = await fetchJson<ArtifactDetailResponse>(
    `/api/workspace/artifacts/${artifactId}`,
    undefined,
    "Could not load the artifact version.",
  );
  return response.artifact;
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

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
