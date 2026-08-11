"use client";

import { Icon } from "@ai-workspace/umber/components/media/Icon";
import { fetchJson } from "@/lib/client-api";
import {
  computeArtifactLineDiff,
  createTextReviewAnchor,
  resolveTextReviewAnchor,
  type ArtifactLineDiff,
} from "@/lib/artifact-diff";
import type {
  ArtifactReviewAnchor,
  ArtifactReviewCommentView,
  ArtifactReviewPermissions,
  ArtifactReviewSelection,
} from "@/lib/artifact-review-client";
import type {
  WorkspaceArtifactDetail,
  WorkspaceArtifactSummary,
  WorkspaceArtifactVersionSet,
} from "@/lib/workspace-artifacts";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ArtifactPreviewContentProps {
  artifact: WorkspaceArtifactSummary;
  onClose?: () => void;
  focusReviewCommentId?: string;
  onAddressComments?: (
    comments: ArtifactReviewSelection[],
  ) => Promise<boolean>;
}

interface ArtifactDetailResponse {
  artifact: WorkspaceArtifactDetail;
}

type ArtifactReviewMode = "preview" | "source" | "compare";

interface ArtifactComparison {
  from: WorkspaceArtifactDetail;
  to: WorkspaceArtifactDetail;
}

interface ArtifactReviewCommentsResponse {
  artifactId: string;
  artifactVersionNumber: number;
  permissions: ArtifactReviewPermissions;
  comments: ArtifactReviewCommentView[];
}

export function ArtifactPreviewContent({
  artifact,
  onClose,
  focusReviewCommentId,
  onAddressComments,
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
  const [reviewOpen, setReviewOpen] = useState(Boolean(focusReviewCommentId));
  const [reviewComments, setReviewComments] =
    useState<ArtifactReviewCommentsResponse | null>(null);
  const [reviewCommentsError, setReviewCommentsError] = useState<string>();
  const [reviewReloadKey, setReviewReloadKey] = useState(0);
  const [anchorToReveal, setAnchorToReveal] =
    useState<ArtifactReviewAnchor>();
  const sourceRef = useRef<HTMLPreElement>(null);
  const activeArtifact = detail ?? artifact;
  const content = detail ? displayContent(detail) : "";
  const sourceAvailable = isTextReviewFormat(activeArtifact);

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
    setReviewComments(null);
    setReviewCommentsError(undefined);
    fetchJson<ArtifactReviewCommentsResponse>(
      `/api/workspace/artifacts/${artifact.id}/review-comments`,
      undefined,
      "Could not load review comments.",
    )
      .then((data) => {
        if (!cancelled) setReviewComments(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setReviewCommentsError(
            err instanceof Error ? err.message : String(err),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, reviewReloadKey]);

  useEffect(() => {
    if (!focusReviewCommentId || !reviewComments) return;
    setReviewOpen(true);
    const focusedComment = reviewComments.comments.find(
      (comment) => comment.id === focusReviewCommentId,
    );
    if (!focusedComment) {
      setReviewCommentsError(
        "This review comment is no longer available on this artifact version.",
      );
      return;
    }
    setReviewCommentsError(undefined);
    if (focusedComment?.anchor.kind === "text-range" && sourceAvailable) {
      setReviewMode("source");
      setAnchorToReveal(focusedComment.anchor);
    }
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`artifact-review-comment-${focusReviewCommentId}`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusReviewCommentId, reviewComments, sourceAvailable]);

  useEffect(() => {
    if (
      reviewMode !== "source" ||
      anchorToReveal?.kind !== "text-range" ||
      !sourceRef.current
    ) {
      return;
    }
    const resolved = resolveTextReviewAnchor(content, anchorToReveal);
    if (!resolved) {
      setReviewCommentsError(
        "This comment's source selection is no longer available.",
      );
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      revealTextRangeWithin(
        sourceRef.current!,
        resolved.startOffset,
        resolved.endOffset,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [anchorToReveal, content, reviewMode]);

  useEffect(() => {
    let cancelled = false;
    setReviewMode("preview");
    setVersionSet(null);
    setVersionError(undefined);
    setComparison(null);
    setComparisonError(undefined);
    setFromVersionId(artifact.id);
    setToVersionId(artifact.id);
    setAnchorToReveal(undefined);

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

  const previewKind = useMemo(
    () => detectPreviewKind(activeArtifact, content),
    [activeArtifact, content],
  );
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
        commentCount={reviewComments?.comments.length ?? 0}
        reviewOpen={reviewOpen}
        onReviewOpenChange={setReviewOpen}
        onCompareLatest={() => {
          if (!versionSet) return;
          setFromVersionId(versionSet.selectedArtifactId);
          setToVersionId(versionSet.latestArtifactId);
          setReviewMode("compare");
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
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
            ref={sourceRef}
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
        {reviewOpen ? (
          <ArtifactReviewCommentsPane
            artifact={activeArtifact}
            content={content}
            sourceRef={sourceRef}
            sourceSelectionAvailable={reviewMode === "source" && sourceAvailable}
            data={reviewComments}
            loadError={reviewCommentsError}
            staleBase={Boolean(versionSet?.staleBase)}
            focusCommentId={focusReviewCommentId}
            onReload={() => setReviewReloadKey((value) => value + 1)}
            onAddressComments={onAddressComments}
            onRevealAnchor={(anchor) => {
              setAnchorToReveal(anchor);
              setReviewMode("source");
            }}
          />
        ) : null}
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
  commentCount,
  reviewOpen,
  onReviewOpenChange,
}: {
  artifact: WorkspaceArtifactSummary | WorkspaceArtifactDetail;
  mode: ArtifactReviewMode;
  sourceAvailable: boolean;
  compareAvailable: boolean;
  versionSet: WorkspaceArtifactVersionSet | null;
  versionError?: string;
  onModeChange: (mode: ArtifactReviewMode) => void;
  onCompareLatest: () => void;
  commentCount: number;
  reviewOpen: boolean;
  onReviewOpenChange: (open: boolean) => void;
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
        <button
          type="button"
          aria-expanded={reviewOpen}
          aria-controls="artifact-review-comments"
          onClick={() => onReviewOpenChange(!reviewOpen)}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
            reviewOpen
              ? "border-ink bg-ink text-canvas"
              : "border-hairline text-muted hover:bg-subtle hover:text-ink"
          }`}
        >
          <Icon name="message-square" size={13} strokeWidth={1.6} />
          Comments{commentCount > 0 ? ` ${commentCount}` : ""}
        </button>
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

function ArtifactReviewCommentsPane({
  artifact,
  content,
  sourceRef,
  sourceSelectionAvailable,
  data,
  loadError,
  staleBase,
  focusCommentId,
  onReload,
  onAddressComments,
  onRevealAnchor,
}: {
  artifact: WorkspaceArtifactSummary | WorkspaceArtifactDetail;
  content: string;
  sourceRef: React.RefObject<HTMLPreElement | null>;
  sourceSelectionAvailable: boolean;
  data: ArtifactReviewCommentsResponse | null;
  loadError?: string;
  staleBase: boolean;
  focusCommentId?: string;
  onReload: () => void;
  onAddressComments?: (
    comments: ArtifactReviewSelection[],
  ) => Promise<boolean>;
  onRevealAnchor: (anchor: ArtifactReviewAnchor) => void;
}) {
  const [draft, setDraft] = useState("");
  const [draftAnchor, setDraftAnchor] = useState<ArtifactReviewAnchor>({
    kind: "artifact",
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string>();
  const [editingBody, setEditingBody] = useState("");
  const [pendingAction, setPendingAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [linkCopiedId, setLinkCopiedId] = useState<string>();
  const comments = data?.comments ?? [];
  const openComments = comments.filter((comment) => comment.status === "open");
  const selected = openComments
    .filter((comment) => selectedIds.includes(comment.id))
    .map((comment) => ({ id: comment.id, revision: comment.revision }));

  useEffect(() => {
    setDraft("");
    setDraftAnchor({ kind: "artifact" });
    setSelectedIds([]);
    setEditingId(undefined);
    setActionError(undefined);
  }, [artifact.id]);

  useEffect(() => {
    const openIds = new Set(
      (data?.comments ?? [])
        .filter((comment) => comment.status === "open")
        .map((comment) => comment.id),
    );
    setSelectedIds((current) => current.filter((id) => openIds.has(id)));
  }, [data?.comments]);

  function captureSourceSelection() {
    const offsets = sourceRef.current
      ? selectionOffsetsWithin(sourceRef.current)
      : null;
    if (!offsets) {
      setActionError("Select text in Source, then choose Comment selection.");
      return;
    }
    try {
      setDraftAnchor(
        createTextReviewAnchor(content, offsets.startOffset, offsets.endOffset),
      );
      setActionError(undefined);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function createComment() {
    if (!draft.trim() || pendingAction) return;
    setPendingAction("create");
    setActionError(undefined);
    try {
      await fetchJson(
        `/api/workspace/artifacts/${artifact.id}/review-comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: draft, anchor: draftAnchor }),
        },
        "Could not add the review comment.",
      );
      setDraft("");
      setDraftAnchor({ kind: "artifact" });
      onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function updateComment(
    comment: ArtifactReviewCommentView,
    update: { body?: string; status?: "open" | "addressed" },
  ) {
    if (pendingAction) return;
    setPendingAction(comment.id);
    setActionError(undefined);
    try {
      await fetchJson(
        `/api/workspace/artifacts/${artifact.id}/review-comments/${comment.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: comment.revision,
            ...update,
          }),
        },
        "Could not update the review comment.",
      );
      setEditingId(undefined);
      onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function addressSelected() {
    if (!onAddressComments || selected.length === 0 || pendingAction) return;
    setPendingAction("address");
    setActionError(undefined);
    try {
      const accepted = await onAddressComments(selected);
      if (accepted) {
        setSelectedIds([]);
        onReload();
      } else {
        setActionError("Comparative did not accept the review request.");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(undefined);
    }
  }

  async function copyCommentLink(commentId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("open", "studio");
    url.searchParams.set("artifactId", artifact.id);
    url.searchParams.set("reviewComment", commentId);
    try {
      await navigator.clipboard.writeText(url.toString());
      setLinkCopiedId(commentId);
      window.setTimeout(() => setLinkCopiedId(undefined), 1_500);
    } catch {
      setActionError("Could not copy the review link.");
    }
  }

  return (
    <aside
      id="artifact-review-comments"
      aria-label="Artifact review comments"
      className="flex max-h-[46%] min-h-0 shrink-0 flex-col border-t border-hairline bg-canvas lg:h-full lg:max-h-none lg:w-[min(22rem,42%)] lg:border-l lg:border-t-0"
      data-testid="artifact-review-comments"
    >
      <header className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b border-hairline px-3">
        <div>
          <h3 className="text-xs font-semibold text-ink">Review</h3>
          <p className="font-mono text-2xs text-muted">
            v{artifact.versionNumber} · {comments.length} comment
            {comments.length === 1 ? "" : "s"}
          </p>
        </div>
        {sourceSelectionAvailable ? (
          <button
            type="button"
            onClick={captureSourceSelection}
            className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-muted hover:bg-subtle hover:text-ink"
          >
            Comment selection
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {data?.permissions.canComment ? (
          <div className="border-b border-hairline px-3 py-3">
            <label
              htmlFor="artifact-review-comment-body"
              className="text-xs font-medium text-ink"
            >
              Add comment
            </label>
            {draftAnchor.kind === "text-range" ? (
              <div className="mt-1 flex items-start gap-2 border-l-2 border-ink pl-2 text-2xs leading-relaxed text-muted">
                <span className="min-w-0 flex-1 line-clamp-2">
                  “{draftAnchor.quote}”
                </span>
                <button
                  type="button"
                  onClick={() => setDraftAnchor({ kind: "artifact" })}
                  className="shrink-0 underline underline-offset-2 hover:text-ink"
                >
                  Clear
                </button>
              </div>
            ) : (
              <p className="mt-1 text-2xs text-muted">Whole artifact</p>
            )}
            <textarea
              id="artifact-review-comment-body"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              maxLength={2_000}
              placeholder="What should change?"
              className="mt-2 w-full resize-y rounded-md border border-hairline bg-canvas px-2.5 py-2 text-xs leading-relaxed text-ink outline-none placeholder:text-muted focus:border-muted"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => void createComment()}
                disabled={!draft.trim() || Boolean(pendingAction)}
                className="rounded-md bg-ink px-2.5 py-1.5 text-xs font-medium text-canvas disabled:cursor-not-allowed disabled:opacity-40"
              >
                Add comment
              </button>
            </div>
          </div>
        ) : null}

        {loadError ? (
          <p className="border-b border-hairline px-3 py-2 text-xs text-danger">
            {loadError}
          </p>
        ) : null}
        {actionError ? (
          <p
            role="alert"
            className="border-b border-hairline px-3 py-2 text-xs text-danger"
          >
            {actionError}
          </p>
        ) : null}
        {staleBase ? (
          <p className="border-b border-warning/30 bg-warning-bg px-3 py-2 text-xs text-ink">
            A newer version exists. Compare it before addressing feedback.
          </p>
        ) : null}

        {!data && !loadError ? (
          <p className="px-3 py-6 text-center text-xs text-muted">
            Loading comments...
          </p>
        ) : comments.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted">
            No review comments on this version.
          </p>
        ) : (
          <div className="divide-y divide-hairline">
            {comments.map((comment) => {
              const focused = focusCommentId === comment.id;
              const editing = editingId === comment.id;
              return (
                <article
                  id={`artifact-review-comment-${comment.id}`}
                  key={comment.id}
                  className={`px-3 py-3 ${focused ? "bg-subtle" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    {data?.permissions.canAddress && comment.status === "open" ? (
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(comment.id)}
                        onChange={(event) =>
                          setSelectedIds((current) =>
                            event.target.checked
                              ? [...current, comment.id]
                              : current.filter((id) => id !== comment.id),
                          )
                        }
                        aria-label={`Select comment by ${comment.author.displayName}`}
                        className="mt-0.5 h-3.5 w-3.5 accent-current"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-xs font-medium text-ink">
                          {comment.author.displayName}
                        </span>
                        <span className="font-mono text-2xs uppercase text-muted">
                          {comment.status === "addressing"
                            ? "Addressing"
                            : comment.status}
                        </span>
                        <span className="text-2xs text-muted">
                          {formatShortDate(comment.createdAt)}
                        </span>
                      </div>
                      {comment.anchor.kind === "text-range" ? (
                        <button
                          type="button"
                          onClick={() => onRevealAnchor(comment.anchor)}
                          aria-label={`Show source selection for comment by ${comment.author.displayName}`}
                          className="mt-1 line-clamp-2 w-full border-l-2 border-hairline pl-2 text-left text-2xs leading-relaxed text-muted hover:border-muted hover:text-ink"
                        >
                          “{comment.anchor.quote}”
                        </button>
                      ) : null}
                      {editing ? (
                        <div className="mt-2">
                          <textarea
                            aria-label="Edit review comment"
                            value={editingBody}
                            onChange={(event) => setEditingBody(event.target.value)}
                            rows={3}
                            maxLength={2_000}
                            className="w-full resize-y rounded-md border border-hairline bg-canvas px-2 py-1.5 text-xs text-ink outline-none focus:border-muted"
                          />
                          <div className="mt-1.5 flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingId(undefined)}
                              className="text-2xs text-muted hover:text-ink"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={!editingBody.trim() || Boolean(pendingAction)}
                              onClick={() =>
                                void updateComment(comment, { body: editingBody })
                              }
                              className="text-2xs font-medium text-ink disabled:opacity-40"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink">
                          {comment.body}
                        </p>
                      )}
                      {!editing ? (
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs">
                          {comment.permissions.canEdit ? (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(comment.id);
                                setEditingBody(comment.body);
                              }}
                              className="text-muted hover:text-ink"
                            >
                              Edit
                            </button>
                          ) : null}
                          {comment.permissions.canResolve ? (
                            <button
                              type="button"
                              onClick={() =>
                                void updateComment(comment, { status: "addressed" })
                              }
                              className="text-muted hover:text-ink"
                            >
                              Resolve
                            </button>
                          ) : null}
                          {comment.permissions.canReopen ? (
                            <button
                              type="button"
                              onClick={() =>
                                void updateComment(comment, { status: "open" })
                              }
                              className="text-muted hover:text-ink"
                            >
                              Reopen
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void copyCommentLink(comment.id)}
                            className="text-muted hover:text-ink"
                          >
                            {linkCopiedId === comment.id ? "Copied" : "Copy link"}
                          </button>
                          {comment.resultArtifactId ? (
                            <a
                              href={`/chat?open=studio&artifactId=${encodeURIComponent(comment.resultArtifactId)}`}
                              className="text-muted underline underline-offset-2 hover:text-ink"
                            >
                              Open revision
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {data?.permissions.canAddress && onAddressComments ? (
        <div className="shrink-0 border-t border-hairline px-3 py-2.5">
          <button
            type="button"
            onClick={() => void addressSelected()}
            disabled={
              selected.length === 0 ||
              staleBase ||
              Boolean(pendingAction)
            }
            className="w-full rounded-md bg-ink px-3 py-2 text-xs font-medium text-canvas disabled:cursor-not-allowed disabled:opacity-40"
          >
            Address with Comparative
            {selected.length > 0 ? ` (${selected.length})` : ""}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

export function selectionOffsetsWithin(
  element: HTMLElement,
  selection: Selection | null = window.getSelection(),
): { startOffset: number; endOffset: number } | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (
    !element.contains(range.startContainer) ||
    !element.contains(range.endContainer)
  ) {
    return null;
  }
  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(element);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(element);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const startOffset = beforeStart.toString().length;
  const endOffset = beforeEnd.toString().length;
  return endOffset > startOffset ? { startOffset, endOffset } : null;
}

export function revealTextRangeWithin(
  element: HTMLElement,
  startOffset: number,
  endOffset: number,
  selection: Selection | null = window.getSelection(),
): boolean {
  if (!selection || startOffset < 0 || endOffset <= startOffset) return false;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let start: { node: Text; offset: number } | undefined;
  let end: { node: Text; offset: number } | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const nextCursor = cursor + text.data.length;
    if (!start && startOffset >= cursor && startOffset <= nextCursor) {
      start = { node: text, offset: startOffset - cursor };
    }
    if (endOffset >= cursor && endOffset <= nextCursor) {
      end = { node: text, offset: endOffset - cursor };
      break;
    }
    cursor = nextCursor;
  }
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  element.scrollIntoView({ block: "nearest" });
  return true;
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
