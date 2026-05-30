"use client";

import { useTheme } from "@/lib/theme";
import {
  buildToolActivityEvents,
  summarizeActivity,
  type AgentActivityEvent,
} from "@/lib/activity-events";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import { useState } from "react";
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
  const activitySummary = summarizeActivity(activityEvents, pending, status);
  const showActivity =
    role === "assistant" && (activityEvents.length > 0 || showThinking);

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
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={MARKDOWN_COMPONENTS}
          >
            {content}
          </ReactMarkdown>
        ) : (
          <span className="whitespace-pre-wrap">{content}</span>
        )}
        {pending && !showThinking ? (
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-[1px] animate-pulse bg-current align-baseline" />
        ) : null}
      </div>
      {role === "assistant" && artifacts.length > 0 ? (
        <ArtifactStrip artifacts={artifacts} />
      ) : null}
      {showActivity ? (
        <ActivityTimeline
          events={activityEvents}
          summary={activitySummary ?? "Thinking..."}
          pending={pending}
        />
      ) : null}
    </div>
  );
}

function ArtifactStrip({
  artifacts,
}: {
  artifacts: WorkspaceArtifactSummary[];
}) {
  return (
    <div className="mt-1 flex max-w-full flex-wrap gap-2">
      {artifacts.map((artifact) => (
        <a
          key={artifact.id}
          href={artifact.previewUrl}
          target="_blank"
          rel="noreferrer"
          className="flex max-w-full items-center gap-2 rounded-md border border-hairline bg-subtle/45 px-2.5 py-1.5 text-[12px] text-ink hover:bg-subtle"
        >
          <span className="shrink-0 rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted">
            {artifact.kind.slice(0, 4)}
          </span>
          <span className="min-w-0 truncate">{artifact.filename}</span>
          <span className="shrink-0 text-muted">{formatBytes(artifact.sizeBytes)}</span>
        </a>
      ))}
    </div>
  );
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

function ActivityTimeline({
  events,
  summary,
  pending,
}: {
  events: AgentActivityEvent[];
  summary: string;
  pending?: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="mt-1 flex items-center gap-2 text-[12px] text-muted">
        <ActivityDot state={pending ? "pending" : "succeeded"} />
        <span>{summary}</span>
      </div>
    );
  }

  return (
    <details className="group mt-1 max-w-full overflow-hidden rounded-md border border-hairline bg-subtle/45 px-2.5 py-1.5 text-[12px] text-muted">
      <summary className="flex cursor-pointer list-none items-center gap-2 [overflow-wrap:anywhere] marker:hidden">
        <ActivityDot
          state={
            events.some((e) => e.state === "failed")
              ? "failed"
              : pending
                ? "pending"
                : "succeeded"
          }
        />
        <span>{summary}</span>
        <span className="ml-auto text-[11px] text-muted/80 group-open:hidden">
          Details
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-1.5 border-t border-hairline pt-2">
        {events.map((event) => (
          <div key={event.id} className="flex min-w-0 gap-2">
            <ActivityDot state={event.state} />
            <div className="min-w-0 flex-1">
              <div className="text-ink [overflow-wrap:anywhere]">
                {event.label}
              </div>
              {event.detail ? (
                <div className="mt-0.5 line-clamp-2 font-mono text-[11px] leading-snug [overflow-wrap:anywhere]">
                  {event.detail}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function ActivityDot({ state }: { state: AgentActivityEvent["state"] }) {
  const className =
    state === "failed"
      ? "bg-red-500"
      : state === "pending"
        ? "animate-pulse bg-muted"
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
