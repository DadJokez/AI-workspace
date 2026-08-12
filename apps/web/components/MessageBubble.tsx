"use client";

import type { AssistantSource } from "@ai-workspace/agent/sources";
import { useTheme } from "@/lib/theme";
import { formatTurnMeter } from "@/lib/turn-cost";
import {
  buildToolActivityEvents,
  summarizeActivity,
  type AgentActivityEvent,
} from "@/lib/activity-events";
import {
  groupActivityEvents,
  summarizeActivityReceipts,
} from "@/lib/activity-receipts";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type {
  PersistedRecommendation,
  RecommendationStatus,
} from "@/lib/recommendations";
import type { AppDraftVersionSummary } from "@/lib/app-draft-versions";
import { escapeBareOrderedListMarkers } from "@/lib/chat-markdown";
import { parseSlashDisplayMessage } from "@/lib/skill-commands";
import { formatMessageTimestamp } from "@/lib/message-time";
import {
  contextResourceReceiptSummary,
  contextResourceStateLabel,
  type ContextResourceManifest,
  type ContextResourceSearchResult,
} from "@/lib/context-shelf";
import {
  outputProposalFromMetadata,
  PROPOSAL_ITERATION_MAX_FEEDBACK_CHARS,
  type OutputProposalDecision,
} from "@/lib/output-proposals";
import { useEffect, useId, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";

interface Props {
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt?: string;
  nowMs?: number;
  modelId?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** #359 live footer inputs — set only while the run is pending. */
  livePhase?: string;
  liveTokens?: number;
  pending?: boolean;
  status?: string;
  attachmentPreviews?: Array<{ name: string; sizeBytes?: number }>;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  artifacts?: WorkspaceArtifactSummary[];
  appDraftVersions?: AppDraftVersionSummary[];
  recommendations?: PersistedRecommendation[];
  activityEvents?: AgentActivityEvent[];
  sources?: AssistantSource[];
  contextResourceManifest?: ContextResourceManifest;
  contextResourceSelections?: ContextResourceSearchResult[];
  assistantName?: string | null;
  onOpenArtifact?: (artifact: WorkspaceArtifactSummary) => void;
  onOpenSource?: (source: AssistantSource) => void;
  onDeployAppDraft?: (version: AppDraftVersionSummary) => void;
  onDiscardAppProposal?: (version: AppDraftVersionSummary) => void;
  onIterateAppProposal?: (
    version: AppDraftVersionSummary,
    feedback: string,
  ) => void;
  onArtifactProposalAction?: (
    artifact: WorkspaceArtifactSummary,
    decision: OutputProposalDecision,
  ) => void;
  onIterateArtifactProposal?: (
    artifact: WorkspaceArtifactSummary,
    feedback: string,
  ) => void;
  onRecommendationAction?: (
    recommendation: PersistedRecommendation,
    status: RecommendationStatus,
  ) => void;
  recommendationPendingId?: string;
  appDraftPendingId?: string;
  artifactProposalPendingId?: string;
  onEdit?: () => void;
  onRegenerate?: () => void;
  onBranch?: () => void;
  onBranchAppVersion?: (version: AppDraftVersionSummary) => void;
  onBranchProposal?: (artifact: WorkspaceArtifactSummary) => void;
  branchPending?: boolean;
}

export function MessageBubble({
  role,
  content,
  createdAt,
  nowMs,
  modelId,
  tokensIn,
  tokensOut,
  livePhase,
  liveTokens,
  pending,
  status,
  attachmentPreviews = [],
  toolCalls = [],
  toolResults = [],
  artifacts = [],
  appDraftVersions = [],
  recommendations = [],
  activityEvents: persistedActivityEvents,
  sources = [],
  contextResourceManifest,
  contextResourceSelections = [],
  assistantName,
  onOpenArtifact,
  onOpenSource,
  onDeployAppDraft,
  onDiscardAppProposal,
  onIterateAppProposal,
  onArtifactProposalAction,
  onIterateArtifactProposal,
  onRecommendationAction,
  recommendationPendingId,
  appDraftPendingId,
  artifactProposalPendingId,
  onEdit,
  onRegenerate,
  onBranch,
  onBranchAppVersion,
  onBranchProposal,
  branchPending,
}: Props) {
  const timestamp =
    typeof nowMs === "number"
      ? formatMessageTimestamp(createdAt, nowMs)
      : null;

  if (role === "user") {
    const slashDisplay = parseSlashDisplayMessage(content);
    const attachedFiles = userAttachmentItems(artifacts, attachmentPreviews);
    return (
      <div
        data-testid="user-message"
        className="group flex w-full min-w-0 max-w-full flex-col items-end gap-1.5 overflow-hidden"
      >
        <div className="flex w-full min-w-0 items-center justify-end">
          {timestamp ? (
            <time
              dateTime={timestamp.iso}
              title={timestamp.iso}
              data-testid="user-message-time"
              className="mr-1 shrink-0 text-2xs text-muted opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
            >
              {timestamp.label}
            </time>
          ) : null}
          {onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              aria-label="Edit message"
              title="Edit message"
              className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted opacity-70 transition-[color,opacity,background-color] hover:bg-subtle hover:text-ink focus-visible:bg-subtle focus-visible:text-ink focus-visible:opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
            >
              <PencilIcon />
            </button>
          ) : null}
          {onBranch ? (
            <MessageBranchButton
              onClick={onBranch}
              pending={branchPending}
            />
          ) : null}
          <div
            data-testid="user-message-content"
            className="max-w-[80%] overflow-hidden rounded-lg bg-subtle px-3.5 py-2 text-base leading-relaxed text-ink [overflow-wrap:anywhere]"
          >
            {slashDisplay ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <span
                  data-testid="slash-capability-pill"
                  className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-subtle px-2 py-0.5 font-mono text-xs text-ink"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-info" />
                  {slashDisplay.token}
                </span>
                {slashDisplay.body ? (
                  <span className="whitespace-pre-wrap">
                    {slashDisplay.body}
                  </span>
                ) : null}
              </span>
            ) : (
              <UserMarkdown content={content} />
            )}
          </div>
        </div>
        {attachedFiles.length > 0 ? (
          <UserAttachmentStrip
            files={attachedFiles}
            onOpenArtifact={onOpenArtifact}
          />
        ) : null}
        {contextResourceSelections.length > 0 ||
        contextResourceManifest?.items.length ? (
          <UserContextSelectionStrip
            selections={contextResourceSelections}
            manifest={contextResourceManifest}
          />
        ) : null}
      </div>
    );
  }

  const assistantLabel = assistantName?.trim() || "Assistant";
  const label =
    role === "tool"
      ? "Tool"
      : modelId
        ? `${assistantLabel} · ${modelId}`
        : assistantLabel;

  // While the assistant is working but no text has streamed yet, surface
  // an animated indicator with the current activity (e.g. "Calling github…").
  // Without this, the bubble looks frozen between the user's send and the
  // first text-delta — a window that can be many seconds long when MCP
  // tool calls are in flight.
  const showThinking = role === "assistant" && pending && content.length === 0;
  const activityEvents =
    role === "assistant"
      ? persistedActivityEvents ?? buildToolActivityEvents(toolCalls, toolResults)
      : [];
  const activitySummary =
    (!pending ? summarizeActivityReceipts(activityEvents) : undefined) ??
    summarizeActivity(activityEvents, pending, status);
  const showActivity =
    role === "assistant" && (activityEvents.length > 0 || showThinking);
  const assistantParts =
    role === "assistant" && !showThinking
      ? splitAssistantContent(content, artifacts, Boolean(pending))
      : [];
  const appArtifactIds = new Set(
    appDraftVersions.map((version) => version.artifactId),
  );
  const standaloneProposalArtifacts = artifacts.filter((artifact) => {
    const proposal = outputProposalFromMetadata(artifact.metadata);
    return (
      (proposal?.status === "proposed" ||
        proposal?.status === "iterating" ||
        proposal?.status === "discarded" ||
        proposal?.status === "superseded") &&
      !appArtifactIds.has(artifact.id)
    );
  });
  const normalArtifacts = artifacts.filter((artifact) => {
    const proposal = outputProposalFromMetadata(artifact.metadata);
    return (
      proposal?.status !== "proposed" &&
      proposal?.status !== "iterating" &&
      proposal?.status !== "discarded" &&
      proposal?.status !== "superseded"
    );
  });

  // Suppress the "Assistant" label-only stub left behind when a turn errors
  // out before any text streamed. The error bar carries the message instead.
  if (role === "assistant" && !pending && content.length === 0) return null;

  return (
    <div
      data-testid={role === "assistant" ? "assistant-message" : undefined}
      className="group flex w-full min-w-0 max-w-full flex-col gap-1 overflow-hidden"
    >
      <div className="flex min-h-7 items-center gap-2">
        <div className="text-2xs font-medium tracking-wide text-muted">
          {label}
        </div>
        {timestamp ? (
          <time
            dateTime={timestamp.iso}
            title={timestamp.iso}
            data-testid="assistant-message-time"
            className="shrink-0 text-2xs text-muted/80"
          >
            {timestamp.label}
          </time>
        ) : null}
        {role === "assistant" && !pending ? (
          (() => {
            const meter = formatTurnMeter(modelId, tokensIn, tokensOut);
            return meter ? (
              <div
                className="text-2xs tracking-wide text-muted/80"
                title="Estimate at standard rates: total tokens include cache reads (billed ~10% of standard) and cache writes (~125%), so the real cost can land under or over this. The admin run page has the exact split."
              >
                {meter}
              </div>
            ) : null;
          })()
        ) : null}
        {role === "assistant" && !pending && content.trim() ? (
          <MessageCopyButton content={content} />
        ) : null}
        {role === "assistant" && !pending && onRegenerate ? (
          <MessageRegenerateButton onClick={onRegenerate} />
        ) : null}
        {role === "assistant" && !pending && onBranch ? (
          <MessageBranchButton
            onClick={onBranch}
            pending={branchPending}
          />
        ) : null}
      </div>
      <div
        data-testid={
          role === "assistant" ? "assistant-message-content" : undefined
        }
        className="min-w-0 max-w-full overflow-hidden px-px text-base leading-relaxed text-ink [overflow-wrap:anywhere]"
      >
        {showThinking ? null : role === "assistant" ? (
          <AssistantContent parts={assistantParts} />
        ) : (
          <span className="whitespace-pre-wrap">{content}</span>
        )}
      </div>
      {role === "assistant" && sources.length > 0 ? (
        <SourceStrip
          sources={sources}
          artifacts={artifacts}
          onOpenArtifact={onOpenArtifact}
          onOpenSource={onOpenSource}
        />
      ) : null}
      {role === "assistant" && standaloneProposalArtifacts.length > 0 ? (
        <ArtifactProposalStrip
          artifacts={standaloneProposalArtifacts}
          pendingId={artifactProposalPendingId}
          onOpenArtifact={onOpenArtifact}
          onAction={onArtifactProposalAction}
          onIterate={onIterateArtifactProposal}
          onBranch={onBranchProposal}
          branchPending={branchPending}
        />
      ) : null}
      {role === "assistant" && normalArtifacts.length > 0 ? (
        <ArtifactStrip
          artifacts={normalArtifacts}
          onOpenArtifact={onOpenArtifact}
        />
      ) : null}
      {role === "assistant" && appDraftVersions.length > 0 ? (
        <AppDraftStrip
          versions={appDraftVersions}
          artifacts={artifacts}
          pendingId={appDraftPendingId}
          onOpenArtifact={onOpenArtifact}
          onDeploy={onDeployAppDraft}
          onDiscard={onDiscardAppProposal}
          onIterate={onIterateAppProposal}
          onBranch={onBranchAppVersion}
          branchPending={branchPending}
        />
      ) : null}
      {role === "assistant" && recommendations.length > 0 ? (
        <RecommendationStrip
          recommendations={recommendations}
          pendingId={recommendationPendingId}
          onAction={onRecommendationAction}
        />
      ) : null}
      {role === "assistant" && contextResourceManifest?.items.length ? (
        <ContextResourceReceipt manifest={contextResourceManifest} />
      ) : null}
      {showActivity ? (
        <WorkReceipts
          events={activityEvents}
          summary={activitySummary ?? "Thinking..."}
          pending={pending}
          livePhase={livePhase}
          liveTokens={liveTokens}
        />
      ) : null}
    </div>
  );
}

function UserContextSelectionStrip({
  selections,
  manifest,
}: {
  selections: readonly ContextResourceSearchResult[];
  manifest?: ContextResourceManifest;
}) {
  const items =
    selections.length > 0
      ? selections.map((selection) => ({
          key: `${selection.reference.kind}:${selection.reference.containerId ?? ""}:${selection.reference.resourceId}`,
          label: selection.label,
          sourceLabel: selection.sourceLabel,
        }))
      : (manifest?.items ?? []).map((item) => ({
          key: `${item.reference.kind}:${item.reference.containerId ?? ""}:${item.reference.resourceId}`,
          label: item.label,
          sourceLabel: item.sourceLabel,
        }));
  return (
    <div
      data-testid="user-context-resources"
      className="flex max-w-[80%] flex-wrap justify-end gap-1.5"
    >
      {items.map((item) => (
        <span
          key={item.key}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-info/35 bg-info/10 px-2 py-1 text-xs text-ink"
          title={`${item.sourceLabel}: ${item.label}`}
        >
          <span className="shrink-0 font-mono text-info">@</span>
          <span className="max-w-48 truncate">{item.label}</span>
          <span className="shrink-0 text-2xs text-muted">
            {item.sourceLabel}
          </span>
        </span>
      ))}
    </div>
  );
}

function ContextResourceReceipt({
  manifest,
}: {
  manifest: ContextResourceManifest;
}) {
  const attention = manifest.items.some((item) => item.state !== "included");
  return (
    <details
      data-testid="context-resource-receipt"
      className="group mt-2 max-w-full overflow-hidden border-t border-hairline/70 pt-2 text-xs text-muted/80"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 marker:hidden">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${attention ? "bg-warning" : "bg-info"}`}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-muted/90">
          {contextResourceReceiptSummary(manifest)}
        </span>
        <span className="shrink-0 text-base leading-none text-muted/60 transition group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-1 pl-3">
        {manifest.items.map((item) => (
          <div
            key={`${item.reference.kind}:${item.reference.containerId ?? ""}:${item.reference.resourceId}`}
            className="flex min-w-0 items-baseline gap-2"
          >
            <span className="min-w-0 flex-1 truncate text-muted/90">
              {item.label}
            </span>
            <span className="shrink-0 text-2xs text-muted/60">
              {item.sourceLabel} · {contextResourceStateLabel(item)}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function UserMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={USER_MARKDOWN_COMPONENTS}
      allowedElements={USER_MARKDOWN_ELEMENTS}
      unwrapDisallowed
    >
      {content}
    </ReactMarkdown>
  );
}

interface UserAttachmentItem {
  key: string;
  name: string;
  sizeBytes?: number;
  artifact?: WorkspaceArtifactSummary;
}

function userAttachmentItems(
  artifacts: readonly WorkspaceArtifactSummary[],
  previews: readonly { name: string; sizeBytes?: number }[],
): UserAttachmentItem[] {
  const items: UserAttachmentItem[] = previews.map((preview, index) => ({
    key: `preview:${index}:${preview.name}`,
    ...preview,
  }));
  for (const artifact of artifacts) {
    if (artifact.source !== "user-upload") continue;
    const persisted: UserAttachmentItem = {
      key: `artifact:${artifact.id}`,
      name: artifact.filename,
      sizeBytes: artifact.sizeBytes,
      artifact,
    };
    const previewIndex = items.findIndex(
      (item) => !item.artifact && item.name === artifact.filename,
    );
    if (previewIndex >= 0) {
      items[previewIndex] = persisted;
    } else {
      items.push(persisted);
    }
  }
  return items;
}

function UserAttachmentStrip({
  files,
  onOpenArtifact,
}: {
  files: readonly UserAttachmentItem[];
  onOpenArtifact?: (artifact: WorkspaceArtifactSummary) => void;
}) {
  return (
    <div
      data-testid="message-attachments"
      aria-label="Attached files"
      className="flex max-w-[80%] flex-wrap justify-end gap-1.5"
    >
      {files.map((file) => {
        const content = (
          <>
            <span className="shrink-0 font-mono text-2xs uppercase text-muted">
              File
            </span>
            <span className="min-w-0 truncate font-medium">{file.name}</span>
            {typeof file.sizeBytes === "number" ? (
              <span className="shrink-0 text-muted">
                {formatBytes(file.sizeBytes)}
              </span>
            ) : null}
          </>
        );
        const className =
          "flex max-w-full items-center gap-1.5 rounded-md border border-hairline bg-canvas px-2 py-1 text-left text-xs text-ink";
        return file.artifact && onOpenArtifact ? (
          <button
            key={file.key}
            type="button"
            data-testid="message-attachment-pill"
            aria-label={`Open attached file ${file.name}`}
            className={`${className} transition hover:bg-subtle`}
            onClick={() => onOpenArtifact(file.artifact!)}
          >
            {content}
          </button>
        ) : (
          <span
            key={file.key}
            data-testid="message-attachment-pill"
            className={className}
          >
            {content}
          </span>
        );
      })}
    </div>
  );
}

function MessageCopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — silently no-op */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied message" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted opacity-70 transition-[color,opacity,background-color] hover:bg-subtle hover:text-ink focus-visible:bg-subtle focus-visible:text-ink focus-visible:opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
    >
      {copied ? <CheckIcon /> : <ClipboardIcon />}
    </button>
  );
}

function MessageRegenerateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Regenerate response"
      title="Regenerate response"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted opacity-70 transition-[color,opacity,background-color] hover:bg-subtle hover:text-ink focus-visible:bg-subtle focus-visible:text-ink focus-visible:opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
    >
      <RegenerateIcon />
    </button>
  );
}

function MessageBranchButton({
  onClick,
  pending,
}: {
  onClick: () => void;
  pending?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-label="Try another approach from here"
      title="Try another approach from here"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted opacity-70 transition-[color,opacity,background-color] hover:bg-subtle hover:text-ink focus-visible:bg-subtle focus-visible:text-ink focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-40 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
    >
      <BranchIcon />
    </button>
  );
}

function BranchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4" cy="3" r="1.4" />
      <circle cx="12" cy="6" r="1.4" />
      <circle cx="4" cy="13" r="1.4" />
      <path d="M4 4.4v5.2M5.4 6h5.2M4 9.6c0-2 1.3-3.6 3.2-3.6" />
    </svg>
  );
}

function AppDraftStrip({
  versions,
  artifacts,
  pendingId,
  onOpenArtifact,
  onDeploy,
  onDiscard,
  onIterate,
  onBranch,
  branchPending,
}: {
  versions: AppDraftVersionSummary[];
  artifacts: WorkspaceArtifactSummary[];
  pendingId?: string;
  onOpenArtifact?: (artifact: WorkspaceArtifactSummary) => void;
  onDeploy?: (version: AppDraftVersionSummary) => void;
  onDiscard?: (version: AppDraftVersionSummary) => void;
  onIterate?: (
    version: AppDraftVersionSummary,
    feedback: string,
  ) => void;
  onBranch?: (version: AppDraftVersionSummary) => void;
  branchPending?: boolean;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {versions.map((version) => {
        const artifact = artifacts.find(
          (candidate) => candidate.id === version.artifactId,
        );
        const pending = pendingId === version.id;
        const deployed = version.status === "deployed";
        // Reconciliation (#344) delivers "reverted" as a steady state: a
        // version that was live and has since been superseded. It must not
        // read as a fresh draft.
        const reverted = version.status === "reverted";
        const proposed = version.status === "proposed";
        const iterating = version.status === "iterating";
        const discarded = version.status === "discarded";
        const superseded = version.status === "superseded";
        const statusDot = deployed
          ? "bg-success"
          : reverted || discarded || superseded
            ? "bg-muted"
            : "bg-info";
        const delta = artifactLineDelta(artifact);
        return (
          <div
            key={version.id}
            data-testid="app-draft-card"
            data-app-version-id={version.id}
            className="rounded-md border border-hairline bg-surface px-3 py-2.5 text-xs text-ink"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
              <span className="font-medium">{version.appName}</span>
              <span className="text-muted">v{version.versionNumber}</span>
              <span className="ml-auto rounded bg-subtle px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted">
                {deployed
                  ? "Published"
                  : reverted
                    ? "Superseded"
                    : superseded
                      ? "Superseded"
                    : discarded
                      ? "Discarded"
                      : iterating
                        ? "Iterating"
                      : proposed
                        ? "Needs review"
                        : "Draft"}
              </span>
            </div>
            <p className="mt-1 text-muted">
              {deployed
                ? "This version is now published."
                : reverted
                  ? "This version is no longer published."
                  : superseded
                    ? "A newer proposal replaced this one. Its history is preserved; the live app has not changed."
                  : discarded
                    ? "This proposal was discarded. Its history is preserved."
                    : iterating
                      ? "Comparative is creating a replacement proposal. The live app has not changed."
                    : proposed
                      ? `${artifact?.versionSummary ?? "A background run proposed this update."} The live app has not changed.`
                      : "Draft saved. The live app has not changed."}
            </p>
            {delta ? (
              <p className="mt-1 font-mono text-2xs text-muted">{delta}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={!artifact}
                onClick={() => artifact && onOpenArtifact?.(artifact)}
                className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink hover:bg-subtle disabled:opacity-40"
              >
                Preview
              </button>
              {onBranch ? (
                <button
                  type="button"
                  disabled={branchPending}
                  onClick={() => onBranch(version)}
                  className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink hover:bg-subtle disabled:cursor-wait disabled:opacity-40"
                >
                  Try another approach
                </button>
              ) : null}
              {deployed ? (
                <a
                  href={version.liveUrl}
                  className="rounded-md border border-accent bg-accent px-2 py-1 text-2xs font-medium text-on-accent hover:bg-accent/90"
                >
                  Open app
                </a>
              ) : reverted || discarded || superseded || iterating ? null : version.canDeploy ? (
                <button
                  type="button"
                  disabled={pending || !onDeploy}
                  onClick={() => onDeploy?.(version)}
                  className="rounded-md border border-accent bg-accent px-2 py-1 text-2xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
                >
                  {pending
                    ? proposed
                      ? "Accepting..."
                      : "Publishing..."
                    : proposed
                      ? "Accept and publish"
                      : "Publish update"}
                </button>
              ) : (
                <span className="text-2xs text-muted">
                  Ready for an owner to publish
                </span>
              )}
              {proposed && onDiscard ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onDiscard(version)}
                  className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink hover:bg-subtle disabled:opacity-50"
                >
                  Discard
                </button>
              ) : null}
            </div>
            {proposed && onIterate ? (
              <ProposalIterationForm
                label={version.appName}
                disabled={pending}
                onSubmit={(feedback) => onIterate(version, feedback)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ArtifactProposalStrip({
  artifacts,
  pendingId,
  onOpenArtifact,
  onAction,
  onIterate,
  onBranch,
  branchPending,
}: {
  artifacts: WorkspaceArtifactSummary[];
  pendingId?: string;
  onOpenArtifact?: (artifact: WorkspaceArtifactSummary) => void;
  onAction?: (
    artifact: WorkspaceArtifactSummary,
    decision: OutputProposalDecision,
  ) => void;
  onIterate?: (
    artifact: WorkspaceArtifactSummary,
    feedback: string,
  ) => void;
  onBranch?: (artifact: WorkspaceArtifactSummary) => void;
  branchPending?: boolean;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {artifacts.map((artifact) => {
        const proposal = outputProposalFromMetadata(artifact.metadata);
        if (!proposal) return null;
        const pending = pendingId === artifact.id;
        const iterating = proposal.status === "iterating";
        const discarded = proposal.status === "discarded";
        const superseded = proposal.status === "superseded";
        const delta = artifactLineDelta(artifact);
        return (
          <div
            key={artifact.id}
            data-testid="output-proposal-card"
            data-artifact-id={artifact.id}
            className="rounded-md border border-hairline bg-surface px-3 py-2.5 text-xs text-ink"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  discarded || superseded ? "bg-muted" : "bg-info"
                }`}
              />
              <span className="min-w-0 truncate font-medium">
                {artifact.filename}
              </span>
              <span className="ml-auto rounded bg-subtle px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted">
                {discarded
                  ? "Discarded"
                  : superseded
                    ? "Superseded"
                    : iterating
                      ? "Iterating"
                      : "Needs review"}
              </span>
            </div>
            <p className="mt-1 text-muted">
              {discarded
                ? "This proposal was discarded. Its history is preserved."
                : superseded
                  ? "A newer proposal replaced this one. Its history is preserved."
                  : iterating
                    ? "Comparative is creating a replacement proposal."
                : (artifact.versionSummary ??
                  "A background run proposed this document update.")}
            </p>
            {delta ? (
              <p className="mt-1 font-mono text-2xs text-muted">{delta}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={!onOpenArtifact}
                onClick={() => onOpenArtifact?.(artifact)}
                className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink hover:bg-subtle disabled:opacity-40"
              >
                Preview
              </button>
              {onBranch ? (
                <button
                  type="button"
                  disabled={branchPending}
                  onClick={() => onBranch(artifact)}
                  className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink hover:bg-subtle disabled:cursor-wait disabled:opacity-40"
                >
                  Try another approach
                </button>
              ) : null}
              {proposal.status === "proposed" ? (
                <>
                  <button
                    type="button"
                    disabled={pending || !onAction}
                    onClick={() => onAction?.(artifact, "accepted")}
                    className="rounded-md border border-accent bg-accent px-2 py-1 text-2xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
                  >
                    {pending ? "Saving..." : "Accept"}
                  </button>
                  <button
                    type="button"
                    disabled={pending || !onAction}
                    onClick={() => onAction?.(artifact, "discarded")}
                    className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink hover:bg-subtle disabled:opacity-50"
                  >
                    Discard
                  </button>
                </>
              ) : null}
            </div>
            {proposal.status === "proposed" && onIterate ? (
              <ProposalIterationForm
                label={artifact.filename}
                disabled={pending}
                onSubmit={(feedback) => onIterate(artifact, feedback)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ProposalIterationForm({
  label,
  disabled,
  onSubmit,
}: {
  label: string;
  disabled: boolean;
  onSubmit: (feedback: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const feedbackId = useId();
  const normalized = feedback.trim();

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="mt-2 rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink hover:bg-subtle disabled:opacity-50"
      >
        Iterate
      </button>
    );
  }

  return (
    <form
      className="mt-2 border-t border-hairline pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!normalized || disabled) return;
        onSubmit(normalized);
        setFeedback("");
        setOpen(false);
      }}
    >
      <label
        htmlFor={feedbackId}
        className="text-2xs font-medium text-muted"
      >
        Feedback
      </label>
      <textarea
        id={feedbackId}
        aria-label={`Feedback for ${label}`}
        rows={2}
        maxLength={PROPOSAL_ITERATION_MAX_FEEDBACK_CHARS}
        disabled={disabled}
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="Describe the change"
        className="mt-1 w-full resize-y rounded-md border border-hairline bg-canvas px-2.5 py-2 text-xs text-ink outline-none placeholder:text-muted focus:border-ink/40 disabled:opacity-50"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setFeedback("");
            setOpen(false);
          }}
          className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-muted hover:bg-subtle hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={disabled || !normalized}
          className="rounded-md border border-accent bg-accent px-2 py-1 text-2xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
        >
          Submit iteration
        </button>
      </div>
    </form>
  );
}

function artifactLineDelta(
  artifact: WorkspaceArtifactSummary | undefined,
): string | null {
  const value = artifact?.metadata?.lineDelta;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const delta = value as Record<string, unknown>;
  if (
    typeof delta.added !== "number" ||
    typeof delta.removed !== "number"
  ) {
    return null;
  }
  const approximate = delta.approximate === true ? "~" : "";
  return `${approximate}+${delta.added} -${delta.removed} lines`;
}

function RecommendationStrip({
  recommendations,
  pendingId,
  onAction,
}: {
  recommendations: PersistedRecommendation[];
  pendingId?: string;
  onAction?: (
    recommendation: PersistedRecommendation,
    status: RecommendationStatus,
  ) => void;
}) {
  const visible = recommendations.filter((r) => r.status !== "dismissed");
  if (visible.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {visible.map((recommendation) => {
        const pending = pendingId === recommendation.dbId;
        const accepted = recommendation.status === "accepted";
        return (
          <div
            key={recommendation.dbId}
            className="rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-ink"
            data-testid="recommendation-card"
          >
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-info" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{recommendation.title}</div>
                <div className="mt-0.5 text-muted">
                  {recommendation.reason}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-subtle px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted">
                {recommendationLabel(recommendation.type)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 pl-3.5">
              {accepted ? (
                <span className="rounded-md border border-success/35 bg-success-bg px-2 py-1 text-2xs text-success">
                  Accepted
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onAction?.(recommendation, "accepted")}
                    className="rounded-md border border-accent bg-accent px-2 py-1 text-2xs font-medium text-on-accent hover:bg-accent/90 disabled:opacity-50"
                  >
                    {pending ? "Saving..." : acceptLabel(recommendation)}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onAction?.(recommendation, "dismissed")}
                    className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink hover:bg-subtle disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactStrip({
  artifacts,
  onOpenArtifact,
}: {
  artifacts: WorkspaceArtifactSummary[];
  onOpenArtifact?: (artifact: WorkspaceArtifactSummary) => void;
}) {
  return (
    <div className="mt-1.5 flex max-w-full flex-wrap gap-2">
      {artifacts.map((artifact) =>
        onOpenArtifact ? (
          <button
            key={artifact.id}
            type="button"
            data-testid="artifact-pill"
            data-artifact-id={artifact.id}
            onClick={() => onOpenArtifact(artifact)}
            className={artifactPillClassName}
          >
            <ArtifactPillContent artifact={artifact} />
          </button>
        ) : (
          <a
            key={artifact.id}
            href={artifact.previewUrl}
            data-testid="artifact-pill"
            data-artifact-id={artifact.id}
            className={artifactPillClassName}
          >
            <ArtifactPillContent artifact={artifact} />
          </a>
        ),
      )}
    </div>
  );
}

function SourceStrip({
  sources,
  artifacts,
  onOpenArtifact,
  onOpenSource,
}: {
  sources: AssistantSource[];
  artifacts: WorkspaceArtifactSummary[];
  onOpenArtifact?: (artifact: WorkspaceArtifactSummary) => void;
  onOpenSource?: (source: AssistantSource) => void;
}) {
  return (
    <div
      data-testid="message-sources"
      className="mt-2 flex max-w-full flex-wrap items-center gap-1.5"
      aria-label="Sources consulted"
    >
      <span className="mr-0.5 text-2xs font-medium uppercase text-muted">
        Sources consulted
      </span>
      {sources.map((source) => {
        const artifact = artifactForSource(source, artifacts);
        const content = <SourceChipContent source={source} />;
        const sharedProps = {
          "data-testid": `source-chip-${source.n}`,
          className:
            "inline-flex max-w-full items-center gap-1.5 rounded-full border border-hairline bg-subtle px-2 py-1 text-left text-xs text-muted transition-colors hover:border-muted hover:text-ink",
          title: source.title,
        };

        if (artifact && onOpenArtifact) {
          return (
            <button
              key={source.n}
              type="button"
              {...sharedProps}
              onClick={() => onOpenArtifact(artifact)}
            >
              {content}
            </button>
          );
        }
        if (
          source.url &&
          (source.kind === "web" || source.kind === "repo")
        ) {
          if (onOpenSource) {
            return (
              <button
                key={source.n}
                type="button"
                {...sharedProps}
                onClick={() => onOpenSource(source)}
              >
                {content}
              </button>
            );
          }
          return (
            <a
              key={source.n}
              {...sharedProps}
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              {content}
            </a>
          );
        }
        return (
          <span key={source.n} {...sharedProps}>
            {content}
          </span>
        );
      })}
    </div>
  );
}

function SourceChipContent({ source }: { source: AssistantSource }) {
  return (
    <>
      <span className="shrink-0 text-2xs font-medium uppercase text-muted/80">
        {sourceKindLabel(source.kind)}
      </span>
      <span className="min-w-0 max-w-56 truncate">{source.title}</span>
    </>
  );
}

function artifactForSource(
  source: AssistantSource,
  artifacts: WorkspaceArtifactSummary[],
): WorkspaceArtifactSummary | undefined {
  if (source.kind !== "artifact" && source.kind !== "file") return undefined;
  return artifacts.find(
    (artifact) =>
      source.url === artifact.id ||
      source.url === artifact.previewUrl ||
      source.url === artifact.downloadUrl ||
      source.title === artifact.filename,
  );
}

function sourceKindLabel(kind: AssistantSource["kind"]): string {
  if (kind === "repo") return "Repo";
  if (kind === "artifact") return "Doc";
  if (kind === "file") return "File";
  return "Web";
}

const artifactPillClassName =
  "group flex max-w-full items-center gap-2 rounded-full border border-accent bg-accent px-2.5 py-1.5 text-left text-xs text-on-accent transition hover:bg-accent/90";

function ArtifactPillContent({
  artifact,
}: {
  artifact: WorkspaceArtifactSummary;
}) {
  return (
    <>
      <span className="shrink-0 rounded-full bg-canvas/20 px-1.5 py-0.5 font-mono text-2xs uppercase text-on-accent/85 ring-1 ring-on-accent/25">
        {artifact.kind.slice(0, 4)}
      </span>
      <span className="min-w-0 truncate font-medium">{artifact.filename}</span>
      <span className="shrink-0 text-on-accent/75">
        {formatBytes(artifact.sizeBytes)}
      </span>
      <span className="hidden shrink-0 rounded-full bg-canvas/20 px-1.5 py-0.5 text-2xs font-semibold uppercase text-on-accent/90 group-hover:bg-canvas/30 sm:inline">
        Preview
      </span>
    </>
  );
}

type AssistantPart =
  | { type: "markdown"; content: string }
  | {
      type: "artifact-preview";
      language: string;
      code: string;
      artifact?: WorkspaceArtifactSummary;
      pending?: boolean;
    };

interface RenderableCodeFence {
  start: number;
  end: number;
  info: string;
  language: string;
  code: string;
}

function AssistantContent({ parts }: { parts: AssistantPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.type === "markdown" ? (
          <ReactMarkdown
            key={`markdown-${index}`}
            remarkPlugins={[remarkGfm]}
            components={MARKDOWN_COMPONENTS}
          >
            {escapeBareOrderedListMarkers(part.content)}
          </ReactMarkdown>
        ) : (
          <ArtifactCodePreview
            key={`artifact-preview-${index}`}
            language={part.language}
            code={part.code}
            artifact={part.artifact}
            pending={part.pending}
          />
        ),
      )}
    </>
  );
}

function ArtifactCodePreview({
  language,
  code,
  artifact,
  pending,
}: {
  language: string;
  code: string;
  artifact?: WorkspaceArtifactSummary;
  pending?: boolean;
}) {
  const label = artifact?.filename ?? "generated document";
  const kind = artifact?.kind ?? language ?? "file";
  const saveState = artifact ? null : pending ? "Saving" : "Not saved";

  return (
    <details className="group my-2 overflow-hidden rounded-md border border-hairline bg-subtle first:mt-0 last:mb-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs marker:hidden">
        <span className="h-1.5 w-1.5 rounded-full bg-info" />
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          Document content collapsed
        </span>
        <span className="hidden shrink-0 font-mono text-2xs uppercase text-muted sm:inline">
          {kind}
        </span>
        {saveState ? (
          <span className="shrink-0 rounded-full border border-warning/25 bg-warning-bg px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-warning">
            {saveState}
          </span>
        ) : null}
        <span className="shrink-0 text-2xs text-muted group-open:hidden">
          Show code
        </span>
        <span className="hidden shrink-0 text-2xs text-muted group-open:inline">
          Hide code
        </span>
      </summary>
      <div className="border-t border-hairline">
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-2xs text-muted">
          <span className="min-w-0 truncate">{label}</span>
          <span className="shrink-0">{formatBytes(code.length)}</span>
        </div>
        <pre
          data-testid="artifact-code-preview-scroll"
          className="max-h-[min(60vh,34rem)] overflow-auto whitespace-pre-wrap border-t border-hairline px-3 py-2 font-mono text-2xs leading-relaxed text-ink [overflow-wrap:anywhere]"
        >
          {code}
        </pre>
      </div>
    </details>
  );
}

function splitAssistantContent(
  content: string,
  artifacts: WorkspaceArtifactSummary[],
  pending = false,
): AssistantPart[] {
  const parts: AssistantPart[] = [];
  let lastIndex = 0;
  let collapsedCount = 0;

  for (const fence of extractRenderableCodeFences(content)) {
    const { info, code, language } = fence;
    const artifact = artifacts[collapsedCount];
    const shouldCollapse = isArtifactSizedFence({ info, code, language });

    if (!shouldCollapse) continue;

    const before = content.slice(lastIndex, fence.start);
    if (before.trim()) parts.push({ type: "markdown", content: before });
    parts.push({
      type: "artifact-preview",
      language,
      code,
      artifact,
      pending,
    });
    collapsedCount += 1;
    lastIndex = fence.end;
  }

  if (collapsedCount === 0) {
    const declaredArtifactParts = buildDeclaredTextArtifactParts({
      content,
      artifacts,
      pending,
    });
    if (declaredArtifactParts) return declaredArtifactParts;
  }

  const after = content.slice(lastIndex);
  if (after.trim()) parts.push({ type: "markdown", content: after });

  return parts.length > 0 ? parts : [{ type: "markdown", content }];
}

function extractRenderableCodeFences(content: string): RenderableCodeFence[] {
  const fences: RenderableCodeFence[] = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastClosedFenceEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(content)) !== null) {
    const fullMatch = match[0] ?? "";
    const info = (match[1] ?? "").trim();
    fences.push({
      start: match.index,
      end: match.index + fullMatch.length,
      info,
      language: info.split(/\s+/)[0]?.toLowerCase() || "text",
      code: (match[2] ?? "").trimEnd(),
    });
    lastClosedFenceEnd = fenceRe.lastIndex;
  }

  const tail = content.slice(lastClosedFenceEnd);
  const unclosedFenceRe = /```([^\n`]*)\n/g;
  let unclosedMatch: RegExpExecArray | null = null;
  while (true) {
    const next = unclosedFenceRe.exec(tail);
    if (next === null) break;
    unclosedMatch = next;
  }

  if (unclosedMatch !== null) {
    const info = (unclosedMatch[1] ?? "").trim();
    fences.push({
      start: lastClosedFenceEnd + unclosedMatch.index,
      end: content.length,
      info,
      language: info.split(/\s+/)[0]?.toLowerCase() || "text",
      code: tail
        .slice(unclosedMatch.index + unclosedMatch[0].length)
        .trimEnd(),
    });
  }

  return fences;
}

function buildDeclaredTextArtifactParts({
  content,
  artifacts,
  pending,
}: {
  content: string;
  artifacts: WorkspaceArtifactSummary[];
  pending: boolean;
}): AssistantPart[] | null {
  const match = findDeclaredTextArtifact(content, artifacts);
  if (!match) return null;

  const { artifact, declaration } = match;
  const intro = content
    .slice(0, declaration.index)
    .replace(/[:\s]+$/g, "")
    .trim();
  const preview = content
    .replace(declaration.fullText, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const parts: AssistantPart[] = [];
  if (intro && intro.length <= 220 && !/^\s*(?:[#>*-]|\d+\.)\s+/m.test(intro)) {
    parts.push({ type: "markdown", content: intro });
  }
  parts.push({
    type: "artifact-preview",
    language: artifact.kind === "markdown" ? "markdown" : "text",
    code: preview || content,
    artifact,
    pending,
  });
  return parts;
}

function findDeclaredTextArtifact(
  content: string,
  artifacts: WorkspaceArtifactSummary[],
):
  | {
      artifact: WorkspaceArtifactSummary;
      declaration: { index: number; fullText: string };
    }
  | null {
  const declaredArtifacts = artifacts.filter(isTextArtifact);
  if (declaredArtifacts.length === 0) return null;

  for (const declaration of declaredTextArtifactDeclarations(content)) {
    const normalized = declaration.filename.toLowerCase();
    const artifact = declaredArtifacts.find((candidate) => {
      const filenames = artifactFilenames(candidate).map((name) =>
        name.toLowerCase(),
      );
      return filenames.includes(normalized);
    });
    if (artifact) return { artifact, declaration };
  }

  const metadataArtifact = declaredArtifacts.find((artifact) => {
    const metadata = artifact.metadata;
    return (
      metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      metadata.extractedFrom === "assistant-declared-text-artifact"
    );
  });
  if (!metadataArtifact) return null;

  const firstDeclaration = declaredTextArtifactDeclarations(content)[0];
  return {
    artifact: metadataArtifact,
    declaration: firstDeclaration ?? { index: 0, fullText: "" },
  };
}

function declaredTextArtifactDeclarations(
  content: string,
): Array<{ index: number; fullText: string; filename: string }> {
  const declarations: Array<{
    index: number;
    fullText: string;
    filename: string;
  }> = [];
  const declarationRe =
    /\b(?:written|saved|created|generated)\s+(?:to|as)?\s*`?([A-Za-z0-9._/ -]+\.(?:md|markdown|txt))`?\.?/gi;
  let match: RegExpExecArray | null;
  while ((match = declarationRe.exec(content)) !== null) {
    const filename = match[1]?.trim();
    if (!filename) continue;
    declarations.push({
      index: match.index,
      fullText: match[0],
      filename,
    });
  }
  return declarations;
}

function isTextArtifact(artifact: WorkspaceArtifactSummary): boolean {
  return (
    artifact.kind === "markdown" ||
    artifact.mimeType === "text/markdown" ||
    artifact.mimeType === "text/plain" ||
    /\.(?:md|markdown|txt)$/i.test(artifact.filename)
  );
}

function artifactFilenames(artifact: WorkspaceArtifactSummary): string[] {
  const filenames = new Set([artifact.filename]);
  const metadata = artifact.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const originalFilename = metadata.originalFilename;
    const explicitFilename = metadata.explicitFilename;
    if (typeof originalFilename === "string") filenames.add(originalFilename);
    if (typeof explicitFilename === "string") filenames.add(explicitFilename);
  }
  return [...filenames];
}

function isArtifactSizedFence({
  info,
  code,
  language,
}: {
  info: string;
  code: string;
  language: string;
}): boolean {
  if (/\bfile(?:name)?\s*=|[A-Za-z0-9._ -]+\.[A-Za-z0-9]{1,12}\b/.test(info)) {
    return true;
  }
  if (/<!doctype\s+html|<html[\s>]/i.test(code)) return true;
  if (language === "html" && code.length > 600) return true;
  if ((language === "markdown" || language === "md") && code.length > 900) {
    return true;
  }
  return code.length > 1800;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function recommendationLabel(type: PersistedRecommendation["type"]): string {
  return (
    {
      tool: "Tool",
      save_as_skill: "Skill",
      run_existing_skill: "Skill",
      open_existing_app: "App",
      deploy_artifact_as_app: "App",
      schedule_skill: "Schedule",
    } as Record<PersistedRecommendation["type"], string>
  )[type];
}

function acceptLabel(recommendation: PersistedRecommendation): string {
  if (recommendation.action.kind === "run_skill") return "Run skill";
  if (recommendation.action.kind === "open_app") return "Open app";
  if (recommendation.action.kind === "deploy_app") return "Publish app";
  if (recommendation.action.kind === "create_schedule") return "Approve";
  if (recommendation.action.kind === "create_skill") return "Save as skill";
  return "Use this";
}

/**
 * Collapsible work receipts (#119): the assistant's answer stays primary;
 * the behind-the-scenes work is one quiet grey line, expanding into a few
 * category receipts ("Checked GitHub · 4 steps"), each expanding into
 * human-readable steps, with raw payloads behind one more disclosure.
 */
function formatReceiptTokens(count: number): string {
  if (count >= 1_000) {
    const value = (count / 1_000).toFixed(1);
    return `${value.endsWith(".0") ? value.slice(0, -2) : value}k`;
  }
  return String(count);
}

function WorkReceipts({
  events,
  summary,
  pending,
  livePhase,
  liveTokens,
}: {
  events: AgentActivityEvent[];
  summary: string;
  pending?: boolean;
  livePhase?: string;
  liveTokens?: number;
}) {
  const mounted = useMounted();
  const [fallbackStartedAt, setFallbackStartedAt] = useState<number | null>(
    null,
  );
  const now = useActivityNow(pending && mounted);
  const firstEventAt = firstActivityTime(events);
  const startedAt = firstEventAt ?? fallbackStartedAt ?? 0;
  const endedAt = pending
    ? mounted
      ? now
      : startedAt
    : lastActivityTime(events) ?? startedAt;
  const duration = formatDuration(Math.max(0, endedAt - startedAt));
  // #359 live footer: elapsed · tokens · deterministic phase. Every part is
  // event-derived — never model narration, never a percentage or ETA.
  const liveParts = [
    `Working for ${duration}`,
    ...(pending && typeof liveTokens === "number" && liveTokens > 0
      ? [`${formatReceiptTokens(liveTokens)} tokens`]
      : []),
    ...(pending && livePhase ? [livePhase] : []),
  ];
  const headline = pending ? liveParts.join(" · ") : `Worked for ${duration}`;

  useEffect(() => {
    if (firstEventAt !== null || fallbackStartedAt !== null) return;
    setFallbackStartedAt(Date.now());
  }, [fallbackStartedAt, firstEventAt]);

  if (events.length === 0) {
    return (
      <div className="mt-2 flex items-center gap-2 border-t border-hairline/70 pt-2 text-xs text-muted/80">
        <ActivityDot state={pending ? "pending" : "succeeded"} subtle />
        <span>{pending ? headline : summary}</span>
        {pending ? <span className="text-muted/60">{summary}</span> : null}
      </div>
    );
  }

  const receipts = groupActivityEvents(events);
  const state = events.some((event) => event.state === "failed")
    ? "failed"
    : pending
      ? "pending"
      : "succeeded";
  const eventCount = events.length;
  const eventLabel = `${eventCount} ${eventCount === 1 ? "step" : "steps"}`;

  return (
    <details
      className="group mt-2 max-w-full overflow-hidden border-t border-hairline/70 pt-2 text-xs text-muted/80"
      open={pending}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 [overflow-wrap:anywhere] marker:hidden">
        <ActivityDot state={state} subtle />
        <span className="font-medium text-muted/90">{headline}</span>
        <span className="text-muted/60">{summary}</span>
        <span className="ml-auto hidden shrink-0 text-2xs text-muted/60 sm:inline">
          {eventLabel}
        </span>
        <span className="shrink-0 text-base leading-none text-muted/60 transition group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-1.5 pl-3">
        {receipts.length === 1 ? (
          <ReceiptSteps events={receipts[0]!.events} />
        ) : (
          receipts.map((receipt) => (
            <details
              key={receipt.id}
              className="group/receipt min-w-0"
              open={pending && receipt.state === "pending"}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 [overflow-wrap:anywhere] marker:hidden">
                <ActivityDot state={receipt.state} subtle />
                <span className="min-w-0 flex-1 truncate text-muted/85">
                  {receipt.label}
                </span>
                <span className="shrink-0 text-sm leading-none text-muted/50 transition group-open/receipt:rotate-90">
                  ›
                </span>
              </summary>
              <div className="mt-1 pl-3.5">
                <ReceiptSteps events={receipt.events} />
              </div>
            </details>
          ))
        )}
      </div>
    </details>
  );
}

function ReceiptSteps({ events }: { events: AgentActivityEvent[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {events.map((event) => (
        <div key={event.id} className="flex min-w-0 gap-2 text-muted/75">
          <ActivityDot state={event.state} subtle />
          <div className="min-w-0 flex-1">
            <div className="[overflow-wrap:anywhere]">{event.label}</div>
            {event.detail ? (
              <details className="group/raw mt-0.5">
                <summary className="cursor-pointer list-none text-2xs text-muted/55 hover:text-muted/80 marker:hidden">
                  <span className="group-open/raw:hidden">View details</span>
                  <span className="hidden group-open/raw:inline">
                    Hide details
                  </span>
                </summary>
                <div className="mt-1 max-h-32 overflow-auto rounded border border-hairline/70 bg-canvas/40 px-2 py-1 font-mono text-2xs leading-snug text-muted/65 [overflow-wrap:anywhere]">
                  {event.detail}
                </div>
              </details>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function useMounted() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return mounted;
}

function useActivityNow(active?: boolean) {
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);

  return now;
}

function firstActivityTime(events: readonly AgentActivityEvent[]) {
  for (const event of events) {
    const time = parseActivityTime(event.at);
    if (time !== null) return time;
  }
  return null;
}

function lastActivityTime(events: readonly AgentActivityEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const time = parseActivityTime(events[index]?.at);
    if (time !== null) return time;
  }
  return null;
}

function parseActivityTime(value?: string) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function ActivityDot({
  state,
  subtle,
}: {
  state: AgentActivityEvent["state"];
  subtle?: boolean;
}) {
  const className =
    state === "failed"
      ? "bg-danger"
      : state === "pending"
        ? "animate-pulse bg-muted/80"
        : subtle
          ? "bg-muted/45"
          : "bg-success";
  return (
    <span
      className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${className}`}
      aria-hidden="true"
    />
  );
}

const MARKDOWN_COMPONENTS: Components = {
  p: (props) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: (props) => (
    <h1
      className="my-2 text-base font-semibold first:mt-0 last:mb-0"
      {...props}
    />
  ),
  h2: (props) => (
    <h2
      className="my-2 text-base font-semibold first:mt-0 last:mb-0"
      {...props}
    />
  ),
  h3: (props) => (
    <h3
      className="my-2 text-sm font-semibold first:mt-0 last:mb-0"
      {...props}
    />
  ),
  ul: (props) => (
    <ul className="my-2 list-disc pl-5 first:mt-0 last:mb-0" {...props} />
  ),
  ol: (props) => (
    <ol className="my-2 list-decimal pl-5 first:mt-0 last:mb-0" {...props} />
  ),
  li: (props) => <li className="my-0.5" {...props} />,
  a: (props) => (
    <a className="underline" target="_blank" rel="noreferrer" {...props} />
  ),
  // GFM tables. The outer div gives mobile a horizontal scroll. The table
  // itself uses `width: min-content` so columns expand to their natural
  // width instead of squishing — wide tables overflow into the scroller
  // rather than wrapping cell text. `whitespace-nowrap` on cells keeps
  // each cell on a single line; readers scroll horizontally to see more.
  table: ({ children }) => (
    <div className="my-2 w-full overflow-x-auto first:mt-0 last:mb-0">
      <table
        className="border-collapse text-sm"
        style={{ width: "min-content", minWidth: "100%" }}
      >
        {children}
      </table>
    </div>
  ),
  thead: (props) => <thead className="bg-subtle" {...props} />,
  tbody: (props) => <tbody {...props} />,
  tr: (props) => (
    <tr className="border-b border-hairline last:border-b-0" {...props} />
  ),
  th: (props) => (
    <th
      className="whitespace-nowrap border-b border-hairline px-3 py-2 text-left align-top font-semibold text-ink"
      {...props}
    />
  ),
  td: (props) => (
    <td
      className="whitespace-nowrap px-3 py-2 align-top text-ink"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote
      className="my-2 border-l-2 border-hairline pl-3 text-muted first:mt-0 last:mb-0"
      {...props}
    />
  ),
  hr: () => <hr className="my-3 border-hairline" />,
  // Fenced blocks are rendered fully by `code` (below). Strip the wrapping
  // <pre> ReactMarkdown would otherwise emit so we don't get nested pres.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...rest }) => {
    const match = /language-(\w+)/.exec(className ?? "");
    if (match) {
      const code = String(children ?? "").replace(/\n$/, "");
      return <CodeBlock language={match[1] ?? "text"} code={code} />;
    }
    return (
      <code
        className="break-all rounded bg-subtle px-1 py-0.5 font-mono text-xs"
        {...rest}
      >
        {children}
      </code>
    );
  },
};

const USER_MARKDOWN_ELEMENTS = [
  "p",
  "br",
  "strong",
  "em",
  "del",
  "a",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "blockquote",
];

const USER_MARKDOWN_COMPONENTS: Components = {
  p: (props) => (
    <p
      className="my-1.5 whitespace-pre-wrap first:mt-0 last:mb-0"
      {...props}
    />
  ),
  ul: (props) => (
    <ul className="my-1.5 list-disc pl-5 first:mt-0 last:mb-0" {...props} />
  ),
  ol: (props) => (
    <ol
      className="my-1.5 list-decimal pl-5 first:mt-0 last:mb-0"
      {...props}
    />
  ),
  li: (props) => <li className="my-0.5" {...props} />,
  a: (props) => (
    <a className="underline" target="_blank" rel="noreferrer" {...props} />
  ),
  blockquote: (props) => (
    <blockquote
      className="my-1.5 border-l-2 border-hairline pl-3 text-muted first:mt-0 last:mb-0"
      {...props}
    />
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...rest }) => {
    const match = /language-(\w+)/.exec(className ?? "");
    if (match) {
      const code = String(children ?? "").replace(/\n$/, "");
      return <CodeBlock language={match[1] ?? "text"} code={code} />;
    }
    return (
      <code
        className="break-all rounded bg-canvas/70 px-1 py-0.5 font-mono text-xs"
        {...rest}
      >
        {children}
      </code>
    );
  },
};

function CodeBlock({ language, code }: { language: string; code: string }) {
  const { isDark } = useTheme();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — silently no-op */
    }
  }

  return (
    <div className="relative my-2 overflow-hidden rounded-md border border-hairline first:mt-0 last:mb-0">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute right-2 top-2 z-10 flex h-7 items-center gap-1 rounded bg-canvas/80 px-2 py-1 text-2xs text-muted backdrop-blur transition-colors hover:text-ink"
      >
        {copied ? (
          <>
            <CheckIcon />
            <span>Copied</span>
          </>
        ) : (
          <>
            <ClipboardIcon />
            <span>Copy</span>
          </>
        )}
      </button>
      <SyntaxHighlighter
        language={language}
        style={isDark ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          padding: "0.75rem",
          background: "transparent",
          fontSize: "0.8rem",
          borderRadius: 0,
          // Ensure long lines wrap on narrow viewports instead of forcing a
          // horizontal scrollbar.
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
        codeTagProps={{
          style: {
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          },
        }}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function ClipboardIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="3" width="8" height="11" rx="1.2" />
      <path d="M6 3V2.4A0.6 0.6 0 0 1 6.6 1.8h2.8a0.6 0.6 0 0 1 0.6 0.6V3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3 11.5-.5 2 2-.5 7.8-7.8-1.5-1.5L3 11.5Z" />
      <path d="m9.8 4.7 1.5 1.5" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2v3h-3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}
