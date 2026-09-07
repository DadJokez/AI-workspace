/** Typography equivalence for prose facts, not identifiers, sentinels or exact-output contracts. */
export function normalizeFactText(text: string): string {
  return text.replace(/[\u00a0\u202f]/g, " ").replace(/\u2011/g, "-").replace(/\r\n/g, "\n").replace(/\n$/, "");
}
