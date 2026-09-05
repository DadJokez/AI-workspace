import {
  THREAD_SUMMARY_SCHEMA,
  buildSummarizerInput,
  parseStoredThreadSummary,
  parseThreadSummaryOutput,
  serializeThreadSummary,
  type ModelId,
  type SummarizableMessage,
  type ThreadSummary,
} from "@ai-workspace/agent";
import { getRuntime, type AgentRuntime } from "@ai-workspace/agent-runtime";
import { chatThreads, type Database } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { resolveModelForPurpose } from "@/lib/model-registry";
import { loadThreadPromptHistory } from "@/lib/thread-branches";
import { redactToolPayload } from "@/lib/tool-redaction";
import { DEFAULT_RECENT_MESSAGE_LIMIT } from "@/lib/turn-context";

/**
 * Rolling summary refresh (#771), stage 2 of the context lifecycle. Runs
 * after a turn persists: every message that has aged out of the
 * recent-message window and is not yet covered by the stored summary is
 * folded into `chat_threads.summary` (schema `thread-summary.v1`) through
 * the safe summarizer boundary — the "summaries" model purpose, resolved by
 * the registry; never the judge.
 *
 * Scope: the thread row is read and written under `(id, user_id)`, so a
 * refresh can never touch another user's thread. Output is background data
 * only — it lands in `chat_threads.summary` and nothing else.
 */

/** Summarizer input cap; older pending messages beyond it are dropped, loudly. */
export const THREAD_SUMMARY_INPUT_CHAR_LIMIT = 60_000;
/** Per tool result, after redaction, inside the summarizer transcript. */
export const THREAD_SUMMARY_TOOL_RESULT_CHAR_LIMIT = 600;
/** Per message, inside the summarizer transcript. */
export const THREAD_SUMMARY_MESSAGE_CHAR_LIMIT = 12_000;

export type ThreadSummaryRefreshReceipt =
  | { status: "unchanged"; reason: "thread_not_found" | "nothing_pending" }
  | { status: "failed"; reason: "runtime_error" | "unparseable"; modelId: ModelId }
  | {
      status: "updated";
      modelId: ModelId;
      coveredMessageCount: number;
      summarizedMessages: number;
      droppedMessages: number;
      summaryChars: number;
      tokensIn: number;
      tokensOut: number;
    };

export async function refreshThreadSummary({
  db,
  userId,
  threadId,
  recentMessageLimit = DEFAULT_RECENT_MESSAGE_LIMIT,
  runtime = getRuntime({ runtime: "bedrock" }),
  now = new Date(),
  signal,
}: {
  db: Database;
  userId: string;
  threadId: string;
  /** Must match the turn-context window so summary and raw history tile exactly. */
  recentMessageLimit?: number;
  runtime?: AgentRuntime;
  now?: Date;
  signal?: AbortSignal;
}): Promise<ThreadSummaryRefreshReceipt> {
  const rows = await db
    .select({ summary: chatThreads.summary })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);
  const thread = rows[0];
  if (!thread) return { status: "unchanged", reason: "thread_not_found" };

  const history = await loadThreadPromptHistory({ db, threadId });
  const usable = history.filter((message) => message.content.trim());
  const limit = Math.max(0, Math.floor(recentMessageLimit));
  const agedOut = usable.slice(0, Math.max(0, usable.length - limit));

  let previous = parseStoredThreadSummary(thread.summary);
  let startIndex = 0;
  if (previous) {
    const coveredIndex = agedOut.findIndex(
      (message) => message.id === previous!.coveredThroughMessageId,
    );
    // An edited/branched thread can orphan the covered id; rebuild from scratch
    // rather than carry a summary of messages that no longer exist.
    if (coveredIndex === -1) previous = null;
    else startIndex = coveredIndex + 1;
  }
  const pending = agedOut.slice(startIndex);
  if (pending.length === 0) {
    return { status: "unchanged", reason: "nothing_pending" };
  }

  const { messages: transcript, dropped } = boundedTranscript(pending);
  const input = buildSummarizerInput(transcript, {
    previousSummary: previous
      ? {
          facts: previous.facts,
          openItems: previous.openItems,
          decisions: previous.decisions,
          references: previous.references,
        }
      : null,
  });
  const modelId = await resolveModelForPurpose(db, "summaries");

  let text = "";
  const errors: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  for await (const event of runtime.runTurn({
    threadId: `thread-summary:${threadId}`,
    modelId,
    systemPrompt: input.systemInstruction,
    messages: [{ role: "user", content: input.userContent }],
    context: { userId },
    signal,
  })) {
    if (event.type === "text-delta") text += event.delta;
    else if (event.type === "error") errors.push(event.message);
    else if (event.type === "usage") {
      tokensIn = event.tokensIn;
      tokensOut = event.tokensOut;
    }
  }
  if (errors.length > 0) {
    log({ threadId, userId, modelId, status: "failed", errors });
    return { status: "failed", reason: "runtime_error", modelId };
  }
  const carryOver = parseThreadSummaryOutput(text);
  if (!carryOver) {
    log({ threadId, userId, modelId, status: "failed", reason: "unparseable" });
    return { status: "failed", reason: "unparseable", modelId };
  }

  const coveredMessageCount =
    (previous ? previous.coveredMessageCount : 0) + pending.length;
  const summary: ThreadSummary = {
    schema: THREAD_SUMMARY_SCHEMA,
    coveredThroughMessageId: pending[pending.length - 1]!.id,
    coveredMessageCount,
    updatedAt: now.toISOString(),
    ...carryOver,
  };
  const serialized = serializeThreadSummary(summary);
  await db
    .update(chatThreads)
    .set({ summary: serialized, summaryUpdatedAt: now })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));

  const receipt: ThreadSummaryRefreshReceipt = {
    status: "updated",
    modelId,
    coveredMessageCount,
    summarizedMessages: pending.length - dropped,
    droppedMessages: dropped,
    summaryChars: serialized.length,
    tokensIn,
    tokensOut,
  };
  log({ threadId, userId, ...receipt });
  return receipt;
}

type HistoryMessage = Awaited<ReturnType<typeof loadThreadPromptHistory>>[number];

/**
 * Newest-first fill of the summarizer budget: when pending history exceeds
 * the cap, the OLDEST messages are the ones dropped, and the drop is
 * reported so the receipt (and log) say the summary is incomplete.
 */
function boundedTranscript(pending: readonly HistoryMessage[]): {
  messages: SummarizableMessage[];
  dropped: number;
} {
  const rendered = pending.map(renderSummarizableMessages);
  const kept: SummarizableMessage[][] = [];
  let chars = 0;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const group = rendered[index]!;
    const groupChars = group.reduce(
      (total, message) => total + message.content.length + 12,
      0,
    );
    if (kept.length > 0 && chars + groupChars > THREAD_SUMMARY_INPUT_CHAR_LIMIT) {
      break;
    }
    kept.unshift(group);
    chars += groupChars;
  }
  return { messages: kept.flat(), dropped: rendered.length - kept.length };
}

/**
 * One persisted row becomes its text plus one `tool:` line per tool result —
 * redacted, bounded, and labelled by tool name and call id so the summary
 * can reference the call without carrying the payload.
 */
function renderSummarizableMessages(
  message: HistoryMessage,
): SummarizableMessage[] {
  const role: SummarizableMessage["role"] =
    message.role === "assistant" ? "assistant" : "user";
  const out: SummarizableMessage[] = [
    {
      role,
      content: truncate(message.content, THREAD_SUMMARY_MESSAGE_CHAR_LIMIT),
    },
  ];
  const callNames = new Map(
    parseRecords(message.toolCalls).map((call) => [
      String(call.id ?? ""),
      typeof call.toolName === "string"
        ? call.toolName
        : typeof call.name === "string"
          ? call.name
          : "unknown",
    ]),
  );
  for (const result of parseRecords(message.toolResults)) {
    const toolCallId = typeof result.toolCallId === "string" ? result.toolCallId : "";
    if (!toolCallId) continue;
    const toolName =
      (typeof result.toolName === "string" && result.toolName) ||
      callNames.get(toolCallId) ||
      "unknown";
    const outcome = result.isError === true ? "failed" : "succeeded";
    const payload = truncate(
      stringify(redactToolPayload(result.output)),
      THREAD_SUMMARY_TOOL_RESULT_CHAR_LIMIT,
    );
    out.push({
      role: "tool",
      content: `${toolName} (call ${toolCallId}) ${outcome}: ${payload}`,
    });
  }
  return out;
}

function parseRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)} [truncated]`;
}

function log(fields: Record<string, unknown>): void {
  process.stderr.write(`[thread-summary] ${JSON.stringify(fields)}\n`);
}
