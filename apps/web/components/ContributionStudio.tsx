"use client";

import { StudioMark } from "@ai-workspace/umber/components/media/StudioMark";
import { Icon } from "@ai-workspace/umber/components/media/Icon";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArtifactPreviewContent } from "@/components/ArtifactPreviewPane";
import type { ArtifactReviewSelection } from "@/lib/artifact-review-client";
import { SlideOverPane } from "@/components/SlideOverPane";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import { StudioBrowserPanel } from "@/components/StudioBrowserPanel";
import type { UiMessage } from "@/app/chat/chat-client-state";
import {
  deriveContributionStudio,
  isContributionStudioTab,
  resolveContributionStudioTab,
  type ContributionStudioScope,
  type ContributionStudioTab,
  type StudioFileResource,
  type StudioWorkState,
  type StudioWorkStep,
} from "@/lib/contribution-studio";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import {
  studioBrowserTargetKey,
  type StudioBrowserTargetRequest,
} from "@/lib/studio-browser-contract";

interface ContributionStudioProps {
  messages: readonly UiMessage[];
  threadId?: string;
  artifact?: WorkspaceArtifactSummary;
  requestedTab?: ContributionStudioTab;
  scope?: ContributionStudioScope;
  isAdmin: boolean;
  browserSupported?: boolean;
  requestedBrowserTarget?: StudioBrowserTargetRequest;
  onClose: () => void;
  onOpenArtifact: (
    artifact: WorkspaceArtifactSummary,
    scope: ContributionStudioScope,
  ) => void;
  onOpenRunInspector: (runId: string) => void;
  onBranchArtifact?: (artifact: WorkspaceArtifactSummary) => void;
  branchPending?: boolean;
  focusReviewCommentId?: string;
  onAddressArtifactReview?: (input: {
    artifact: WorkspaceArtifactSummary;
    comments: ArtifactReviewSelection[];
  }) => Promise<boolean>;
}

const TAB_STORAGE_KEY = "comparative.contribution-studio.tab";
const MAXIMIZED_STORAGE_KEY = "comparative.contribution-studio.maximized";

const TAB_LABELS: Record<ContributionStudioTab, string> = {
  preview: "Preview",
  files: "Files",
  browser: "Browser",
  activity: "Activity",
  console: "Console",
};

export function ContributionStudio({
  messages,
  threadId,
  artifact,
  requestedTab,
  scope = "thread",
  isAdmin,
  browserSupported = false,
  requestedBrowserTarget,
  onClose,
  onOpenArtifact,
  onOpenRunInspector,
  onBranchArtifact,
  branchPending,
  focusReviewCommentId,
  onAddressArtifactReview,
}: ContributionStudioProps) {
  const model = useMemo(
    () =>
      deriveContributionStudio(messages, {
        artifact,
        scope,
        capabilities: { browser: browserSupported },
      }),
    [artifact, browserSupported, messages, scope],
  );
  const [activeTab, setActiveTab] = useState<ContributionStudioTab | null>(() =>
    resolveContributionStudioTab({
      available: model.tabs,
      requested: requestedTab,
      scope,
      artifact,
      working: model.working,
    }),
  );
  const [maximized, setMaximized] = useState(false);
  const contextKey = `${scope}:${requestedTab ?? ""}:${artifact?.id ?? ""}:${
    requestedBrowserTarget
      ? studioBrowserTargetKey(requestedBrowserTarget)
      : ""
  }`;
  const previousContextKey = useRef<string | null>(null);

  useEffect(() => {
    const contextChanged = previousContextKey.current !== contextKey;
    previousContextKey.current = contextKey;
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    const remembered = isContributionStudioTab(stored) ? stored : null;
    setActiveTab((current) => {
      if (!contextChanged && current && model.tabs.includes(current)) {
        return current;
      }
      return resolveContributionStudioTab({
        available: model.tabs,
        requested: requestedTab,
        remembered,
        scope,
        artifact,
        working: model.working,
      });
    });
  }, [artifact, contextKey, model.tabs, model.working, requestedTab, scope]);

  useEffect(() => {
    setMaximized(
      window.localStorage.getItem(MAXIMIZED_STORAGE_KEY) === "true",
    );
  }, []);

  function selectTab(tab: ContributionStudioTab) {
    setActiveTab(tab);
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  }

  function updateMaximized(next: boolean) {
    setMaximized(next);
    window.localStorage.setItem(MAXIMIZED_STORAGE_KEY, String(next));
  }

  async function addressArtifactReview(comments: ArtifactReviewSelection[]) {
    if (!onAddressArtifactReview || !model.previewArtifact) return false;
    const accepted = await onAddressArtifactReview({
      artifact: model.previewArtifact,
      comments,
    });
    if (accepted && window.matchMedia("(max-width: 767px)").matches) {
      onClose();
    }
    return accepted;
  }

  const currentTab =
    activeTab && model.tabs.includes(activeTab)
      ? activeTab
      : resolveContributionStudioTab({
          available: model.tabs,
          requested: requestedTab,
          scope,
          artifact,
          working: model.working,
        });

  return (
    <SlideOverPane
      ariaLabel="Contribution Studio"
      defaultWidth={600}
      minWidth={380}
      maxWidth={1440}
      minMainWidth={500}
      maximized={maximized}
      onMaximizedChange={updateMaximized}
      onClose={onClose}
      paneTestId="contribution-studio"
      resizerLabel="Resize Contribution Studio"
      resizerTestId="contribution-studio-resizer"
      storageKey="comparative.slide-over.studio.width"
    >
      <div className="flex h-full min-h-0 flex-col bg-canvas">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <StudioMark
            className="shrink-0 text-ink"
            data-testid="contribution-studio-mark"
            label="Contribution Studio"
            size={24}
            state={model.working ? "working" : "idle"}
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-ink">
              Contribution Studio
            </h2>
          </div>
          {model.working ? (
            <span className="font-mono text-2xs text-muted">Working</span>
          ) : null}
          <button
            type="button"
            aria-label={maximized ? "Restore Studio size" : "Maximize Studio"}
            title={maximized ? "Restore Studio size" : "Maximize Studio"}
            onClick={() => updateMaximized(!maximized)}
            className="hidden h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink md:flex"
          >
            <Icon name="grid" size={15} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            aria-label="Close Contribution Studio"
            title="Close Contribution Studio"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
          >
            <Icon name="x" size={16} strokeWidth={1.6} />
          </button>
        </header>

        <nav
          aria-label="Contribution Studio views"
          className="flex h-10 shrink-0 items-end gap-4 overflow-x-auto border-b border-hairline px-3"
        >
          {model.tabs.map((tab) => (
            <button
              type="button"
              key={tab}
              aria-current={currentTab === tab ? "page" : undefined}
              onClick={() => selectTab(tab)}
              className={`h-10 shrink-0 border-b px-0.5 text-xs font-medium transition-colors ${
                currentTab === tab
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1" data-testid="studio-active-view">
          {currentTab === "preview" && model.previewArtifact ? (
            <ArtifactPreviewContent
              artifact={model.previewArtifact}
              onBranch={onBranchArtifact}
              branchPending={branchPending}
              focusReviewCommentId={focusReviewCommentId}
              onAddressComments={
                onAddressArtifactReview ? addressArtifactReview : undefined
              }
            />
          ) : currentTab === "files" && scope === "workspace" ? (
            <WorkspacePanel
              embedded
              onClose={onClose}
              onOpenArtifact={(nextArtifact) =>
                onOpenArtifact(nextArtifact, scope)
              }
            />
          ) : currentTab === "files" ? (
            <StudioFilesPanel
              files={model.files}
              onOpenArtifact={(nextArtifact) =>
                onOpenArtifact(nextArtifact, scope)
              }
            />
          ) : currentTab === "browser" ? (
            <StudioBrowserPanel
              threadId={threadId}
              resources={model.browserResources}
              requestedTarget={requestedBrowserTarget}
              onRequestMaximize={() => updateMaximized(true)}
            />
          ) : currentTab === "activity" ? (
            <StudioActivityPanel
              steps={model.workSteps}
              isAdmin={isAdmin}
              onOpenRunInspector={onOpenRunInspector}
            />
          ) : null}
        </div>
      </div>
    </SlideOverPane>
  );
}

function StudioFilesPanel({
  files,
  onOpenArtifact,
}: {
  files: readonly StudioFileResource[];
  onOpenArtifact: (artifact: WorkspaceArtifactSummary) => void;
}) {
  return (
    <div className="h-full overflow-y-auto px-3 py-3 sm:px-4">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-baseline justify-between gap-3 border-b border-hairline pb-3">
          <h3 className="text-sm font-semibold text-ink">Thread files</h3>
          <span className="font-mono text-2xs text-muted">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        </div>
        <div className="divide-y divide-hairline">
          {files.map((file) => (
            <div
              key={file.id}
              className="flex min-w-0 items-center gap-3 py-3"
              data-testid="studio-file-row"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-subtle text-muted">
                <Icon name="file-text" size={16} strokeWidth={1.6} />
              </span>
              <div className="min-w-0 flex-1">
                {file.artifact ? (
                  <button
                    type="button"
                    onClick={() => onOpenArtifact(file.artifact!)}
                    className="block max-w-full truncate text-left text-sm font-medium text-ink underline-offset-2 hover:underline"
                  >
                    {file.filename}
                  </button>
                ) : (
                  <p className="truncate text-sm font-medium text-ink">
                    {file.filename}
                  </p>
                )}
                <p className="mt-0.5 truncate text-2xs text-muted">
                  {file.artifact
                    ? `v${file.artifact.versionNumber} · ${sourceLabel(file.source)}`
                    : "Uploading"}
                  {typeof file.sizeBytes === "number"
                    ? ` · ${formatBytes(file.sizeBytes)}`
                    : ""}
                </p>
              </div>
              {file.artifact ? (
                <a
                  href={file.artifact.downloadUrl}
                  aria-label={`Download ${file.filename}`}
                  title={`Download ${file.filename}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
                >
                  <Icon name="download" size={15} strokeWidth={1.6} />
                </a>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StudioActivityPanel({
  steps,
  isAdmin,
  onOpenRunInspector,
}: {
  steps: readonly StudioWorkStep[];
  isAdmin: boolean;
  onOpenRunInspector: (runId: string) => void;
}) {
  const lowLevelCompleted = steps.filter(
    (step) => step.state === "completed" && step.lowLevel,
  );
  const visible = steps.filter(
    (step) => step.state !== "completed" || !step.lowLevel,
  );

  return (
    <div className="h-full overflow-y-auto px-3 py-3 sm:px-4">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-baseline justify-between gap-3 border-b border-hairline pb-3">
          <h3 className="text-sm font-semibold text-ink">Live Work Map</h3>
          <span className="font-mono text-2xs text-muted">
            {steps.length} {steps.length === 1 ? "step" : "steps"}
          </span>
        </div>
        <div className="divide-y divide-hairline" data-testid="studio-work-map">
          {visible.map((step) => (
            <StudioWorkStepRow
              key={step.id}
              step={step}
              isAdmin={isAdmin}
              onOpenRunInspector={onOpenRunInspector}
            />
          ))}
        </div>
        {lowLevelCompleted.length > 0 ? (
          <details className="border-t border-hairline py-2">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-xs font-medium text-muted marker:hidden hover:text-ink">
              <Icon name="chevron-right" size={14} strokeWidth={1.6} />
              Completed details · {lowLevelCompleted.length}
            </summary>
            <div className="divide-y divide-hairline pl-3">
              {lowLevelCompleted.map((step) => (
                <StudioWorkStepRow
                  key={step.id}
                  step={step}
                  isAdmin={isAdmin}
                  onOpenRunInspector={onOpenRunInspector}
                />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function StudioWorkStepRow({
  step,
  isAdmin,
  onOpenRunInspector,
}: {
  step: StudioWorkStep;
  isAdmin: boolean;
  onOpenRunInspector: (runId: string) => void;
}) {
  return (
    <div className="flex min-w-0 gap-3 py-3" data-state={step.state}>
      <span
        aria-label={workStateLabel(step.state)}
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${workStateColor(step.state)}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <p className="min-w-0 flex-1 text-sm text-ink">{step.label}</p>
          {isAdmin && step.runId ? (
            <button
              type="button"
              onClick={() => onOpenRunInspector(step.runId!)}
              className="shrink-0 text-2xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Inspect run
            </button>
          ) : null}
        </div>
        <p className="mt-1 flex flex-wrap gap-x-2 font-mono text-2xs text-muted">
          <span>{workStateLabel(step.state)}</span>
          {step.eventCount > 1 ? <span>{step.eventCount} events</span> : null}
          {typeof step.elapsedMs === "number" ? (
            <span>{formatDuration(step.elapsedMs)}</span>
          ) : null}
          {typeof step.tokensOut === "number" ? (
            <span>{formatNumber(step.tokensOut)} output tokens</span>
          ) : null}
        </p>
        {step.evidence.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {step.evidence.map((item) =>
              item.url ? (
                <a
                  key={item.id}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="max-w-full truncate text-xs text-muted underline underline-offset-2 hover:text-ink"
                >
                  {item.title}
                </a>
              ) : (
                <span key={item.id} className="text-xs text-muted">
                  {item.title}
                </span>
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function workStateLabel(state: StudioWorkState): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function workStateColor(state: StudioWorkState): string {
  if (state === "failed") return "bg-danger";
  if (state === "waiting") return "bg-warning";
  if (state === "active") return "bg-info animate-pulse motion-reduce:animate-none";
  if (state === "planned") return "border border-muted bg-transparent";
  if (state === "canceled") return "bg-muted";
  return "bg-success";
}

function sourceLabel(source: string): string {
  if (source === "user-upload") return "Uploaded";
  if (source === "assistant-code-block") return "Created in chat";
  return source.replaceAll("-", " ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} sec`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact" }).format(value);
}
