"use client";

import { useTheme } from "@/lib/theme";
import {
  buildToolActivityEvents,
  type AgentActivityEvent,
} from "@/lib/activity-events";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import {
  buildWorkReceipts,
  type WorkReceipt,
  type WorkReceiptKind,
} from "@/lib/work-receipts";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
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
  activityEvents?: AgentActivityEvent[];
  onOpenArtifact?: (artifact: WorkspaceArtifactSummary) => void;
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
  activityEvents: persistedActivityEvents,
  onOpenArtifact,
}: Props) {
  if (role === "user") {
    return (
      <div className="flex w-full min-w-0 max-w-full justify-end overflow-hidden">
        <div className="max-w-[80%] overflow-hidden whitespace-pre-wrap rounded-lg bg-subtle px-3.5 py-2 text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]">
          {content}
        </div>
      </div>
    );
  }

  const label =
    role === "tool" ? "Tool" : modelId ? `Assistant · ${modelId}` : "Assistant";

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
  const showActivity =
    role === "assistant" && (activityEvents.length > 0 || showThinking);
  const assistantParts =
    role === "assistant" && !showThinking
      ? splitAssistantContent(content, artifacts)
      : [];

  // Suppress the "Assistant" label-only stub left behind when a turn errors
  // out before any text streamed. The error bar carries the message instead.
  if (role === "assistant" && !pending && content.length === 0) return null;

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-1 overflow-hidden">
      <div className="text-[11px] font-medium tracking-wide text-muted">
        {label}
      </div>
      <div className="min-w-0 max-w-full overflow-hidden text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]">
        {showThinking ? (
          <ThinkingIndicator status={status} />
        ) : role === "assistant" ? (
          <AssistantContent parts={assistantParts} />
        ) : (
          <span className="whitespace-pre-wrap">{content}</span>
        )}
        {pending && !showThinking ? (
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-[1px] animate-pulse bg-current align-baseline" />
        ) : null}
      </div>
      {role === "assistant" && artifacts.length > 0 ? (
        <ArtifactStrip artifacts={artifacts} onOpenArtifact={onOpenArtifact} />
      ) : null}
      {showActivity ? (
        <WorkReceiptTimeline
          events={activityEvents}
          fallbackSummary={status ?? "Thinking..."}
          pending={pending}
        />
      ) : null}
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
            onClick={() => onOpenArtifact(artifact)}
            className={artifactPillClassName}
          >
            <ArtifactPillContent artifact={artifact} />
          </button>
        ) : (
          <a
            key={artifact.id}
            href={artifact.previewUrl}
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
      <span className="shrink-0 rounded-full bg-white/16 px-1.5 py-0.5 font-mono text-[10px] uppercase text-white/86 ring-1 ring-white/18">
        {artifact.kind.slice(0, 4)}
      </span>
      <span className="min-w-0 truncate font-medium">{artifact.filename}</span>
      <span className="shrink-0 text-white/72">
        {formatBytes(artifact.sizeBytes)}
      </span>
      <span className="hidden shrink-0 rounded-full bg-white/18 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white/88 group-hover:bg-white/24 sm:inline">
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
    };

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
            {part.content}
          </ReactMarkdown>
        ) : (
          <ArtifactCodePreview
            key={`artifact-preview-${index}`}
            language={part.language}
            code={part.code}
            artifact={part.artifact}
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
}: {
  language: string;
  code: string;
  artifact?: WorkspaceArtifactSummary;
}) {
  const snippet = code
    .split("\n")
    .slice(0, 18)
    .join("\n")
    .slice(0, 1600)
    .trimEnd();
  const label = artifact?.filename ?? "generated document";
  const kind = artifact?.kind ?? language ?? "file";

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
): AssistantPart[] {
  if (artifacts.length === 0) return [{ type: "markdown", content }];

  const parts: AssistantPart[] = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let collapsedCount = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(content)) !== null) {
    const fullMatch = match[0] ?? "";
    const info = (match[1] ?? "").trim();
    const code = (match[2] ?? "").trimEnd();
    const language = info.split(/\s+/)[0]?.toLowerCase() || "text";
    const artifact = artifacts[collapsedCount];
    const shouldCollapse =
      artifact !== undefined &&
      isArtifactSizedFence({ info, code, language });

    if (!shouldCollapse) continue;

    const before = content.slice(lastIndex, match.index);
    if (before.trim()) parts.push({ type: "markdown", content: before });
    parts.push({
      type: "artifact-preview",
      language,
      code,
      artifact,
    });
    collapsedCount += 1;
    lastIndex = match.index + fullMatch.length;
  }

  const after = content.slice(lastIndex);
  if (after.trim()) parts.push({ type: "markdown", content: after });

  return parts.length > 0 ? parts : [{ type: "markdown", content }];
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

function ThinkingIndicator({ status }: { status?: string }) {
  return (
    <div className="flex items-center gap-2 text-muted">
      <span className="inline-flex items-end gap-[3px]" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
      </span>
      <span className="text-[13px]">{status ?? "Thinking…"}</span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function WorkReceiptTimeline({
  events,
  fallbackSummary,
  pending,
}: {
  events: AgentActivityEvent[];
  fallbackSummary: string;
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
  const receipts = buildWorkReceipts(events, { pending, fallbackSummary });

  useEffect(() => {
    if (firstEventAt !== null || fallbackStartedAt !== null) return;
    setFallbackStartedAt(Date.now());
  }, [fallbackStartedAt, firstEventAt]);

  if (receipts.length === 0) return null;

  return (
    <div className="mt-2 flex max-w-full flex-col gap-1 border-t border-hairline/70 pt-2 text-[12px] text-muted/75">
      {receipts.map((receipt, index) => (
        <WorkReceiptRow
          key={receipt.id}
          receipt={receipt}
          defaultOpen={!!pending}
          durationLabel={index === 0 ? headline : undefined}
        />
      ))}
    </div>
  );
}

function WorkReceiptRow({
  receipt,
  defaultOpen,
  durationLabel,
}: {
  receipt: WorkReceipt;
  defaultOpen?: boolean;
  durationLabel?: string;
}) {
  const stepCount = receipt.steps.length;
  const stepLabel = `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
  const summary = durationLabel
    ? `${durationLabel} · ${receipt.summary}`
    : receipt.summary;

  if (stepCount === 0) {
    return (
      <div className="flex items-center gap-2 py-0.5 text-muted/80 [overflow-wrap:anywhere]">
        <ReceiptIcon kind={receipt.kind} state={receipt.state} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </div>
    );
  }

  return (
    <details className="group/receipt max-w-full overflow-hidden" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 text-muted/80 [overflow-wrap:anywhere] marker:hidden">
        <ReceiptIcon kind={receipt.kind} state={receipt.state} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <span className="hidden shrink-0 text-[11px] text-muted/55 sm:inline">
          {stepLabel}
        </span>
        <span className="shrink-0 text-[14px] leading-none text-muted/55 transition group-open/receipt:rotate-90">
          ›
        </span>
      </summary>
      <div className="mt-1 flex flex-col gap-1.5 pl-5 text-[12px] text-muted/65">
        {receipt.steps.map((step) => (
          <div key={step.id} className="flex min-w-0 gap-2">
            <ActivityDot state={step.state} subtle />
            <div className="min-w-0 flex-1">
              <div className="[overflow-wrap:anywhere]">{step.label}</div>
              {step.detail ? <RawStepDetails detail={step.detail} /> : null}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function RawStepDetails({ detail }: { detail: string }) {
  return (
    <details className="group/raw mt-1 max-w-full overflow-hidden">
      <summary className="cursor-pointer list-none text-[11px] text-muted/55 marker:hidden hover:text-muted/80">
        <span className="group-open/raw:hidden">View details</span>
        <span className="hidden group-open/raw:inline">Hide details</span>
      </summary>
      <pre className="mt-1 max-h-24 overflow-auto rounded border border-hairline/70 bg-canvas/40 px-2 py-1 font-mono text-[11px] leading-snug text-muted/65 [overflow-wrap:anywhere]">
        {detail}
      </pre>
    </details>
  );
}

function ReceiptIcon({
  kind,
  state,
}: {
  kind: WorkReceiptKind;
  state: AgentActivityEvent["state"];
}) {
  const className =
    state === "failed"
      ? "text-red-400"
      : state === "pending"
        ? "text-muted/70"
        : "text-muted/55";

  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center ${className}`}
    >
      {kind === "github" ? (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
          <path
            d="M5.8 8.2 4.6 9.4a2 2 0 1 0 2.8 2.8l1.2-1.2M10.2 7.8l1.2-1.2a2 2 0 1 0-2.8-2.8L7.4 5M6.2 9.8l3.6-3.6"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.4"
          />
        </svg>
      ) : kind === "browser" ? (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
          <rect
            x="2.5"
            y="3"
            width="11"
            height="10"
            rx="1.7"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <path
            d="M2.8 6h10.4M5 4.5h.01M7 4.5h.01"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </svg>
      ) : kind === "deployment" ? (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
          <path
            d="M8 2.8v7.4M5.4 5.4 8 2.8l2.6 2.6M3.5 11.2v1.6h9v-1.6"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.4"
          />
        </svg>
      ) : kind === "attention" ? (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
          <path
            d="M8 2.8 13.2 12H2.8L8 2.8Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.3"
          />
          <path
            d="M8 6.2v2.6M8 10.8h.01"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </svg>
      ) : kind === "workspace" ? (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
          <path
            d="M2.5 5.2h4l1.1 1.3h5.9v6H2.5v-7.3Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.3"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden>
          <path
            d="M8 3.2 12.5 5.8v5.4L8 13.8l-4.5-2.6V5.8L8 3.2Z"
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="1.3"
          />
          <path
            d="M8 8.2v5M3.7 5.9 8 8.2l4.3-2.3"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </svg>
      )}
    </span>
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
