import type { BedrockContentBlock, BedrockMessage } from "./clients";

/**
 * Context lifecycle, stage 1 (#771): stale tool-result clearing.
 *
 * The lightest-touch context edit, applied before any summarization. Tool
 * rounds older than the most recent `keepRecentRounds` have their result
 * payloads replaced by a short structured placeholder — tool name, call id,
 * one-line outcome — once the model-visible transcript exceeds
 * `triggerChars`. Error results are exempt: a later step may depend on the
 * exact error text (a denied approval, a policy block, a provider failure),
 * so they are never rewritten.
 *
 * Cache discipline (ADR 0010): this only rewrites the `messages` region,
 * which sits behind the tools → system cache checkpoints. The stable system
 * prefix is never touched, so clearing cannot regress the cached prefix.
 *
 * Pure: returns a new message array; the loop's own transcript (and every
 * yielded `tool-result` event) keeps the raw payloads.
 */

export const DEFAULT_KEEP_RECENT_TOOL_ROUNDS = 2;
/** ~40K tokens of transcript before clearing engages. */
export const DEFAULT_TOOL_RESULT_CLEAR_TRIGGER_CHARS = 160_000;
export const CLEARED_TOOL_RESULT_MARKER = "[stale tool result cleared]";

const OUTCOME_EXCERPT_CHARS = 160;
const FRAME_MARKER_LINE_RE = /^<<<[^>\n]{1,160}>>>$/;

export interface ClearStaleToolResultsOptions {
  /** Most recent tool rounds whose results always stay intact. */
  keepRecentRounds?: number;
  /**
   * Transcript size (chars) above which eligible rounds are cleared,
   * oldest first, until the transcript fits. `0` clears every eligible
   * round unconditionally.
   */
  triggerChars?: number;
}

export interface ClearedToolResult {
  toolUseId: string;
  toolName: string;
  originalChars: number;
}

export interface ToolResultClearingReceipt {
  cleared: ClearedToolResult[];
  transcriptCharsBefore: number;
  transcriptCharsAfter: number;
  keepRecentRounds: number;
  triggerChars: number;
}

export interface ClearStaleToolResultsOutcome {
  messages: BedrockMessage[];
  receipt: ToolResultClearingReceipt;
}

export function clearStaleToolResults(
  messages: readonly BedrockMessage[],
  {
    keepRecentRounds = DEFAULT_KEEP_RECENT_TOOL_ROUNDS,
    triggerChars = DEFAULT_TOOL_RESULT_CLEAR_TRIGGER_CHARS,
  }: ClearStaleToolResultsOptions = {},
): ClearStaleToolResultsOutcome {
  const keep = Math.max(0, Math.floor(keepRecentRounds));
  const trigger = Math.max(0, Math.floor(triggerChars));
  const before = transcriptChars(messages);
  const receipt: ToolResultClearingReceipt = {
    cleared: [],
    transcriptCharsBefore: before,
    transcriptCharsAfter: before,
    keepRecentRounds: keep,
    triggerChars: trigger,
  };
  if (trigger > 0 && before <= trigger) {
    return { messages: [...messages], receipt };
  }

  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.kind === "tool-use") toolNames.set(block.id, block.name);
    }
  }
  const roundIndexes = messages.flatMap((message, index) =>
    message.role === "user" &&
    message.content.some(
      (block) => block.kind === "tool-result" && !isPlaceholder(block),
    )
      ? [index]
      : [],
  );
  const eligible = roundIndexes.slice(
    0,
    Math.max(0, roundIndexes.length - keep),
  );

  const next = messages.map((message) => ({
    ...message,
    content: [...message.content],
  }));
  let chars = before;
  for (const index of eligible) {
    if (trigger > 0 && chars <= trigger) break;
    const message = next[index]!;
    message.content = message.content.map((block) => {
      if (
        block.kind !== "tool-result" ||
        block.isError === true ||
        isPlaceholder(block)
      ) {
        return block;
      }
      const toolName = toolNames.get(block.toolUseId) ?? "unknown";
      const placeholder = renderPlaceholder(block, toolName);
      // A payload shorter than its placeholder is not worth clearing.
      if (placeholder.content.length >= block.content.length) return block;
      chars -= block.content.length - placeholder.content.length;
      receipt.cleared.push({
        toolUseId: block.toolUseId,
        toolName,
        originalChars: block.content.length,
      });
      return placeholder;
    });
  }
  receipt.transcriptCharsAfter = chars;
  return { messages: next, receipt };
}

function isPlaceholder(
  block: Extract<BedrockContentBlock, { kind: "tool-result" }>,
): boolean {
  return block.content.startsWith(CLEARED_TOOL_RESULT_MARKER);
}

function renderPlaceholder(
  block: Extract<BedrockContentBlock, { kind: "tool-result" }>,
  toolName: string,
): Extract<BedrockContentBlock, { kind: "tool-result" }> {
  return {
    kind: "tool-result",
    toolUseId: block.toolUseId,
    content: [
      `${CLEARED_TOOL_RESULT_MARKER} tool=${toolName} call=${block.toolUseId} outcome=ok; excerpt: ${outcomeExcerpt(block.content)}`,
      "The full payload was cleared from context because it is stale. Do not reconstruct it from memory; re-run the tool if the exact data is needed.",
    ].join("\n"),
  };
}

/**
 * One line of the payload, minus the data-framing scaffolding (#497 marker
 * lines and their preambles) so the placeholder shows what the tool said,
 * not how it was fenced.
 */
function outcomeExcerpt(content: string): string {
  const body = content
    .split("\n")
    .filter(
      (line) =>
        !FRAME_MARKER_LINE_RE.test(line.trim()) &&
        !line.startsWith("Tool result from ") &&
        !line.startsWith("Comparative usage guidance for "),
    )
    .join(" ")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) return "(empty)";
  return body.length > OUTCOME_EXCERPT_CHARS
    ? `${body.slice(0, OUTCOME_EXCERPT_CHARS)}…`
    : body;
}

function transcriptChars(messages: readonly BedrockMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.kind) {
        case "text":
        case "reasoning":
          chars += block.text.length;
          break;
        case "tool-result":
          chars += block.content.length;
          break;
        case "tool-use":
          chars += JSON.stringify(block.input).length + block.name.length;
          break;
        case "image":
        case "reasoning-redacted":
          chars += block.dataBase64.length;
          break;
      }
    }
  }
  return chars;
}
