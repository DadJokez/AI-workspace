/**
 * Line-delta counts for artifact revisions (#359): the `+N −N` on "Edited
 * report.html". Exact Myers O(ND) on lines up to a cost bound; beyond it,
 * falls back to a common-prefix/suffix trim (exact for single-region
 * edits, an upper bound for scattered ones — flagged `approximate` so the
 * UI can render `~`). Pure and dependency-free.
 */

export interface LineDelta {
  added: number;
  removed: number;
  approximate: boolean;
}

export type LineDiffKind = "context" | "added" | "removed" | "omitted";

export interface LineDiffEntry {
  kind: LineDiffKind;
  text: string;
  previousLine: number | null;
  nextLine: number | null;
  omittedLines?: number;
  omissionReason?: "unchanged" | "truncated";
}

export interface ArtifactLineDiff extends LineDelta {
  entries: LineDiffEntry[];
  truncated: boolean;
}

export interface TextReviewAnchor {
  kind: "text-range";
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix: string;
  suffix: string;
}

export interface ResolvedTextReviewAnchor {
  startOffset: number;
  endOffset: number;
  resolution: "exact" | "remapped";
}

const MAX_CONTENT_CHARS = 400_000;
const MAX_D = 1_000;
const MAX_DIFF_MATRIX_CELLS = 1_500_000;
const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_ENTRIES = 2_000;
const ANCHOR_CONTEXT_CHARS = 48;

export function computeLineDelta(
  previous: string,
  next: string,
): LineDelta | null {
  if (previous === next) return { added: 0, removed: 0, approximate: false };
  if (
    previous.length > MAX_CONTENT_CHARS ||
    next.length > MAX_CONTENT_CHARS
  ) {
    return null;
  }
  const a = previous.split("\n");
  const b = next.split("\n");

  // Trim common prefix/suffix first — cheap, and shrinks the Myers input.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 || midB.length === 0) {
    return { added: midB.length, removed: midA.length, approximate: false };
  }

  const lcs = boundedLcsLength(midA, midB, MAX_D);
  if (lcs === null) {
    // Bound exceeded: prefix/suffix counts are an upper bound on churn.
    return { added: midB.length, removed: midA.length, approximate: true };
  }
  return {
    added: midB.length - lcs,
    removed: midA.length - lcs,
    approximate: false,
  };
}

/**
 * Renderable line diff for immutable artifact versions. Small/medium documents
 * use an exact LCS. Large documents degrade to a clearly marked coarse
 * prefix/suffix comparison instead of freezing the browser or pretending the
 * result is exact.
 */
export function computeArtifactLineDiff(
  previous: string,
  next: string,
  {
    contextLines = DEFAULT_CONTEXT_LINES,
    maxEntries = DEFAULT_MAX_DIFF_ENTRIES,
  }: { contextLines?: number; maxEntries?: number } = {},
): ArtifactLineDiff {
  const previousLines = previous.split("\n");
  const nextLines = next.split("\n");
  const exact = buildExactLineDiff(previousLines, nextLines);
  const operations = exact ?? buildCoarseLineDiff(previousLines, nextLines);
  const compacted = compactContext(
    operations,
    Math.max(0, Math.floor(contextLines)),
  );
  const bounded = boundEntries(compacted, Math.max(1, Math.floor(maxEntries)));
  return {
    added: operations.filter((entry) => entry.kind === "added").length,
    removed: operations.filter((entry) => entry.kind === "removed").length,
    approximate: exact === null,
    entries: bounded.entries,
    truncated: bounded.truncated,
  };
}

export function createTextReviewAnchor(
  content: string,
  startOffset: number,
  endOffset: number,
): TextReviewAnchor {
  const start = clampOffset(startOffset, content.length);
  const end = clampOffset(endOffset, content.length);
  if (end <= start) {
    throw new Error("A review anchor must select at least one character.");
  }
  return {
    kind: "text-range",
    startOffset: start,
    endOffset: end,
    quote: content.slice(start, end),
    prefix: content.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: content.slice(end, end + ANCHOR_CONTEXT_CHARS),
  };
}

/**
 * Reopen an anchor on its immutable version, or remap it after a caller has
 * explicitly selected a newer version. Ambiguous quotes fail closed.
 */
export function resolveTextReviewAnchor(
  content: string,
  anchor: TextReviewAnchor,
): ResolvedTextReviewAnchor | null {
  if (
    anchor.startOffset >= 0 &&
    anchor.endOffset <= content.length &&
    content.slice(anchor.startOffset, anchor.endOffset) === anchor.quote
  ) {
    return {
      startOffset: anchor.startOffset,
      endOffset: anchor.endOffset,
      resolution: "exact",
    };
  }

  const candidates: number[] = [];
  let offset = content.indexOf(anchor.quote);
  while (offset >= 0) {
    if (anchorContextMatches(content, offset, anchor)) candidates.push(offset);
    offset = content.indexOf(
      anchor.quote,
      offset + Math.max(1, anchor.quote.length),
    );
  }
  if (candidates.length !== 1) return null;
  return {
    startOffset: candidates[0]!,
    endOffset: candidates[0]! + anchor.quote.length,
    resolution: "remapped",
  };
}

function buildExactLineDiff(
  previous: readonly string[],
  next: readonly string[],
): LineDiffEntry[] | null {
  const width = next.length + 1;
  const cellCount = (previous.length + 1) * width;
  if (cellCount > MAX_DIFF_MATRIX_CELLS) return null;

  const lcs = new Uint32Array(cellCount);
  for (let left = previous.length - 1; left >= 0; left -= 1) {
    for (let right = next.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      lcs[index] =
        previous[left] === next[right]
          ? lcs[(left + 1) * width + right + 1]! + 1
          : Math.max(
              lcs[(left + 1) * width + right]!,
              lcs[left * width + right + 1]!,
            );
    }
  }

  const entries: LineDiffEntry[] = [];
  let left = 0;
  let right = 0;
  while (left < previous.length && right < next.length) {
    if (previous[left] === next[right]) {
      entries.push(diffEntry("context", previous[left]!, left, right));
      left += 1;
      right += 1;
    } else if (
      lcs[(left + 1) * width + right]! >= lcs[left * width + right + 1]!
    ) {
      entries.push(diffEntry("removed", previous[left]!, left, null));
      left += 1;
    } else {
      entries.push(diffEntry("added", next[right]!, null, right));
      right += 1;
    }
  }
  while (left < previous.length) {
    entries.push(diffEntry("removed", previous[left]!, left, null));
    left += 1;
  }
  while (right < next.length) {
    entries.push(diffEntry("added", next[right]!, null, right));
    right += 1;
  }
  return entries;
}

function buildCoarseLineDiff(
  previous: readonly string[],
  next: readonly string[],
): LineDiffEntry[] {
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous[prefix] === next[prefix]
  ) {
    prefix += 1;
  }
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > prefix &&
    nextEnd > prefix &&
    previous[previousEnd - 1] === next[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  const entries: LineDiffEntry[] = [];
  for (let index = 0; index < prefix; index += 1) {
    entries.push(diffEntry("context", previous[index]!, index, index));
  }
  for (let index = prefix; index < previousEnd; index += 1) {
    entries.push(diffEntry("removed", previous[index]!, index, null));
  }
  for (let index = prefix; index < nextEnd; index += 1) {
    entries.push(diffEntry("added", next[index]!, null, index));
  }
  for (let offset = 0; offset < previous.length - previousEnd; offset += 1) {
    entries.push(
      diffEntry(
        "context",
        previous[previousEnd + offset]!,
        previousEnd + offset,
        nextEnd + offset,
      ),
    );
  }
  return entries;
}

function compactContext(
  entries: readonly LineDiffEntry[],
  contextLines: number,
): LineDiffEntry[] {
  const output: LineDiffEntry[] = [];
  let index = 0;
  while (index < entries.length) {
    if (entries[index]!.kind !== "context") {
      output.push(entries[index]!);
      index += 1;
      continue;
    }
    let end = index;
    while (end < entries.length && entries[end]!.kind === "context") end += 1;
    const run = entries.slice(index, end);
    const atStart = index === 0;
    const atEnd = end === entries.length;
    const keepBefore = atStart ? 0 : contextLines;
    const keepAfter = atEnd ? 0 : contextLines;
    const keep = Math.min(run.length, keepBefore + keepAfter);
    if (run.length === keep) {
      output.push(...run);
    } else {
      if (keepBefore > 0) output.push(...run.slice(0, keepBefore));
      output.push({
        kind: "omitted",
        text: "",
        previousLine: null,
        nextLine: null,
        omittedLines: run.length - keep,
        omissionReason: "unchanged",
      });
      if (keepAfter > 0) output.push(...run.slice(run.length - keepAfter));
    }
    index = end;
  }
  return output;
}

function boundEntries(
  entries: readonly LineDiffEntry[],
  maxEntries: number,
): { entries: LineDiffEntry[]; truncated: boolean } {
  if (entries.length <= maxEntries) {
    return { entries: [...entries], truncated: false };
  }
  const kept = entries.slice(0, Math.max(0, maxEntries - 1));
  kept.push({
    kind: "omitted",
    text: "",
    previousLine: null,
    nextLine: null,
    omittedLines: entries.length - kept.length,
    omissionReason: "truncated",
  });
  return { entries: kept, truncated: true };
}

function diffEntry(
  kind: Exclude<LineDiffKind, "omitted">,
  text: string,
  previousIndex: number | null,
  nextIndex: number | null,
): LineDiffEntry {
  return {
    kind,
    text,
    previousLine: previousIndex === null ? null : previousIndex + 1,
    nextLine: nextIndex === null ? null : nextIndex + 1,
  };
}

function clampOffset(value: number, contentLength: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(contentLength, Math.floor(value)));
}

function anchorContextMatches(
  content: string,
  startOffset: number,
  anchor: TextReviewAnchor,
): boolean {
  const prefix = content.slice(
    Math.max(0, startOffset - anchor.prefix.length),
    startOffset,
  );
  const endOffset = startOffset + anchor.quote.length;
  const suffix = content.slice(endOffset, endOffset + anchor.suffix.length);
  return prefix === anchor.prefix && suffix === anchor.suffix;
}

/** Myers-style LCS length with an edit-distance bound; null when exceeded. */
function boundedLcsLength(
  a: readonly string[],
  b: readonly string[],
  maxD: number,
): number | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const offset = max;
  const v = new Array<number>(2 * max + 1).fill(0);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // d = insertions + deletions; lcs = (n + m - d) / 2
        return (n + m - d) / 2;
      }
    }
  }
  return null;
}
