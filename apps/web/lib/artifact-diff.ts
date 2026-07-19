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

const MAX_CONTENT_CHARS = 400_000;
const MAX_D = 1_000;

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
