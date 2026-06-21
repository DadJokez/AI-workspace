"use client";

import { useTheme } from "@/lib/theme";
import {
  buildToolActivityEvents,
  summarizeActivity,
  type AgentActivityEvent,
} from "@/lib/activity-events";
import { groupActivityEvents } from "@/lib/activity-receipts";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type {
  PersistedRecommendation,
  RecommendationStatus,
} from "@/lib/recommendations";
import { escapeBareOrderedListMarkers } from "@/lib/chat-markdown";
import { parseSlashDisplayMessage } from "@/lib/skill-commands";
import { useEffect, useState } from "react";
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
  modelId?: string;
  pending?: boolean;
  status?: string;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  artifacts?: WorkspaceArtifactSummary[];
  recommendations?: PersistedRecommendation[];
  activityEvents?: AgentActivityEvent[];
  assistantName?: string | null;
  onOpenArtifact?: (artifact: WorkspaceArtifactSummary) => void;
  onRecommendationAction?: (
    recommendation: PersistedRecommendation,
    status: RecommendationStatus,
  ) => void;
  recommendationPendingId?: string;
}

export function MessageBubble({
  role,
  content,
  modelId,
  pending,
  status,
  toolCalls = [],
  toolResults = [],
  artifacts = [],
  recommendations = [],
  activityEvents: persistedActivityEvents,
  assistantName,
  onOpenArtifact,
  onRecommendationAction,
  recommendationPendingId,
}: Props) {
  if (role === "user") {
    const slashDisplay = parseSlashDisplayMessage(content);
    return (
      <div className="flex w-full min-w-0 max-w-full justify-end overflow-hidden">
        <div className="max-w-[80%] overflow-hidden whitespace-pre-wrap rounded-lg bg-subtle px-3.5 py-2 text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]">
          {slashDisplay ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span
                data-testid="slash-capability-pill"
                className="inline-flex items-center gap-1.5 rounded-full border border-[#2f6bff]/50 bg-[#06112f]/85 px-2 py-0.5 font-mono text-[12px] text-[#dbe8ff] shadow-[0_0_14px_rgba(0,92,255,0.24)]"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[#28d7ff] shadow-[0_0_10px_rgba(40,215,255,0.7)]" />
                {slashDisplay.token}
              </span>
              {slashDisplay.body ? (
                <span className="whitespace-pre-wrap">{slashDisplay.body}</span>
              ) : null}
            </span>
          ) : (
            content
          )}
        </div>
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
  const activitySummary = summarizeActivity(activityEvents, pending, status);
  const showActivity =
    role === "assistant" && (activityEvents.length > 0 || showThinking);
  const assistantParts =
    role === "assistant" && !showThinking
      ? splitAssistantContent(content, artifacts, Boolean(pending))
      : [];

  // Suppress the "Assistant" label-only stub left behind when a turn errors
  // out before any text streamed. The error bar carries the message instead.
  if (role === "assistant" && !pending && content.length === 0) return null;

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-1 overflow-hidden">
      <div className="text-[11px] font-medium tracking-wide text-muted">
        {label}
      </div>
      <div
        data-testid={
          role === "assistant" ? "assistant-message-content" : undefined
        }
        className="min-w-0 max-w-full overflow-hidden px-px text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]"
      >
        {showThinking ? null : role === "assistant" ? (
          <AssistantContent parts={assistantParts} />
        ) : (
          <span className="whitespace-pre-wrap">{content}</span>
        )}
      </div>
      {role === "assistant" && artifacts.length > 0 ? (
        <ArtifactStrip artifacts={artifacts} onOpenArtifact={onOpenArtifact} />
      ) : null}
      {role === "assistant" && recommendations.length > 0 ? (
        <RecommendationStrip
          recommendations={recommendations}
          pendingId={recommendationPendingId}
          onAction={onRecommendationAction}
        />
      ) : null}
      {showActivity ? (
        <WorkReceipts
          events={activityEvents}
          summary={activitySummary ?? "Thinking..."}
          pending={pending}
        />
      ) : null}
    </div>
  );
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
            className="rounded-md border border-[#2f6bff]/35 bg-[#06112f]/55 px-3 py-2 text-[12px] text-[#dbe8ff]"
          >
            <div className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#28d7ff] shadow-[0_0_12px_rgba(40,215,255,0.8)]" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{recommendation.title}</div>
                <div className="mt-0.5 text-[#9dbdff]">
                  {recommendation.reason}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#b9d2ff]">
                {recommendationLabel(recommendation.type)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 pl-3.5">
              {accepted ? (
                <span className="rounded-md border border-[#67a3ff]/35 bg-[#0b2b77]/40 px-2 py-1 text-[11px] text-[#dbe8ff]">
                  Accepted
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onAction?.(recommendation, "accepted")}
                    className="rounded-md border border-[#67a3ff]/45 bg-[#0b3ed9]/55 px-2 py-1 text-[11px] font-medium text-white hover:bg-[#0b52ff] disabled:opacity-50"
                  >
                    {pending ? "Saving..." : acceptLabel(recommendation)}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onAction?.(recommendation, "dismissed")}
                    className="rounded-md border border-[#67a3ff]/25 px-2 py-1 text-[11px] font-medium text-[#b9d2ff] hover:bg-white/[0.08] disabled:opacity-50"
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

const artifactPillClassName =
  "group flex max-w-full items-center gap-2 rounded-full border border-[#67a3ff]/60 bg-[linear-gradient(135deg,#0637cf_0%,#095cff_54%,#00a6ff_100%)] px-2.5 py-1.5 text-left text-[12px] text-white shadow-[0_0_22px_rgba(0,92,255,0.34)] transition hover:brightness-110";

function ArtifactPillContent({
  artifact,
}: {
  artifact: WorkspaceArtifactSummary;
}) {
  return (
    <>
      <span className="shrink-0 rounded-full bg-white/[0.16] px-1.5 py-0.5 font-mono text-[10px] uppercase text-white/[0.86] ring-1 ring-white/[0.18]">
        {artifact.kind.slice(0, 4)}
      </span>
      <span className="min-w-0 truncate font-medium">{artifact.filename}</span>
      <span className="shrink-0 text-white/[0.72]">
        {formatBytes(artifact.sizeBytes)}
      </span>
      <span className="hidden shrink-0 rounded-full bg-white/[0.18] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white/[0.88] group-hover:bg-white/[0.24] sm:inline">
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
  const snippet = code
    .split("\n")
    .slice(0, 18)
    .join("\n")
    .slice(0, 1600)
    .trimEnd();
  const label = artifact?.filename ?? "generated document";
  const kind = artifact?.kind ?? language ?? "file";
  const saveState = artifact ? null : pending ? "Saving" : "Not saved";

  return (
    <details className="group my-2 overflow-hidden rounded-md border border-[#2f6bff]/40 bg-[#050b1f]/70 first:mt-0 last:mb-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] marker:hidden">
        <span className="h-1.5 w-1.5 rounded-full bg-[#28d7ff] shadow-[0_0_12px_rgba(40,215,255,0.8)]" />
        <span className="min-w-0 flex-1 truncate font-medium text-[#dbe8ff]">
          Document content collapsed
        </span>
        <span className="hidden shrink-0 font-mono text-[10px] uppercase text-[#8cb7ff] sm:inline">
          {kind}
        </span>
        {saveState ? (
          <span className="shrink-0 rounded-full border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-100">
            {saveState}
          </span>
        ) : null}
        <span className="shrink-0 text-[11px] text-[#88a8e8] group-open:hidden">
          Show snippet
        </span>
        <span className="hidden shrink-0 text-[11px] text-[#88a8e8] group-open:inline">
          Hide snippet
        </span>
      </summary>
      <div className="border-t border-[#2f6bff]/25">
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-[#8cb7ff]">
          <span className="min-w-0 truncate">{label}</span>
          <span className="shrink-0">{formatBytes(code.length)}</span>
        </div>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap border-t border-[#2f6bff]/20 px-3 py-2 font-mono text-[11px] leading-relaxed text-[#c9dcff] [overflow-wrap:anywhere]">
          {snippet}
          {snippet.length < code.length ? "\n..." : ""}
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
  if (recommendation.action.kind === "deploy_app") return "Deploy app";
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
function WorkReceipts({
  events,
  summary,
  pending,
}: {
  events: AgentActivityEvent[];
  summary: string;
  pending?: boolean;
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
  const headline = pending ? `Working for ${duration}` : `Worked for ${duration}`;

  useEffect(() => {
    if (firstEventAt !== null || fallbackStartedAt !== null) return;
    setFallbackStartedAt(Date.now());
  }, [fallbackStartedAt, firstEventAt]);

  if (events.length === 0) {
    return (
      <div className="mt-2 flex items-center gap-2 border-t border-hairline/70 pt-2 text-[12px] text-muted/80">
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
      className="group mt-2 max-w-full overflow-hidden border-t border-hairline/70 pt-2 text-[12px] text-muted/80"
      open={pending}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 [overflow-wrap:anywhere] marker:hidden">
        <ActivityDot state={state} subtle />
        <span className="font-medium text-muted/90">{headline}</span>
        <span className="text-muted/60">{summary}</span>
        <span className="ml-auto hidden shrink-0 text-[11px] text-muted/60 sm:inline">
          {eventLabel}
        </span>
        <span className="shrink-0 text-[14px] leading-none text-muted/60 transition group-open:rotate-90">
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
                <span className="shrink-0 text-[13px] leading-none text-muted/50 transition group-open/receipt:rotate-90">
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
                <summary className="cursor-pointer list-none text-[11px] text-muted/55 hover:text-muted/80 marker:hidden">
                  <span className="group-open/raw:hidden">View details</span>
                  <span className="hidden group-open/raw:inline">
                    Hide details
                  </span>
                </summary>
                <div className="mt-1 max-h-32 overflow-auto rounded border border-hairline/70 bg-canvas/40 px-2 py-1 font-mono text-[11px] leading-snug text-muted/65 [overflow-wrap:anywhere]">
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
      ? "bg-red-500"
      : state === "pending"
        ? "animate-pulse bg-muted/80"
        : subtle
          ? "bg-muted/45"
          : "bg-emerald-500";
  return (
    <span
      className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${className}`}
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
        className="border-collapse text-[13px]"
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
        className="break-all rounded bg-subtle px-1 py-0.5 font-mono text-[12px]"
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
        className="absolute right-2 top-2 z-10 flex h-7 items-center gap-1 rounded bg-canvas/80 px-2 py-1 text-[11px] text-muted backdrop-blur transition-colors hover:text-ink"
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
