export type CommandPaletteGroupId =
  | "chats"
  | "skills"
  | "apps"
  | "admin"
  | "actions";

export interface CommandPaletteItem {
  id: string;
  group: CommandPaletteGroupId;
  label: string;
  description?: string | null;
  keywords?: readonly string[];
}

export interface CommandPaletteGroup<T extends CommandPaletteItem> {
  id: CommandPaletteGroupId;
  label: string;
  items: T[];
}

const GROUPS: ReadonlyArray<{
  id: CommandPaletteGroupId;
  label: string;
}> = [
  { id: "chats", label: "Chats" },
  { id: "skills", label: "Skills" },
  { id: "apps", label: "Apps" },
  { id: "admin", label: "Admin" },
  { id: "actions", label: "Actions" },
];

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Scores exact, prefix, word-prefix, substring, then subsequence matches.
 * Returning null keeps non-matches out of the palette entirely.
 */
export function fuzzyScore(value: string, query: string): number | null {
  const candidate = normalize(value);
  const needle = normalize(query);
  if (!needle) return 0;
  if (!candidate) return null;
  if (candidate === needle) return 1_000;
  if (candidate.startsWith(needle)) return 900 - candidate.length;

  const wordIndex = candidate
    .split(" ")
    .findIndex((word) => word.startsWith(needle));
  if (wordIndex >= 0) return 800 - wordIndex;

  const substringIndex = candidate.indexOf(needle);
  if (substringIndex >= 0) return 700 - substringIndex;

  let candidateIndex = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (const character of needle) {
    const match = candidate.indexOf(character, candidateIndex);
    if (match < 0) return null;
    if (firstMatch < 0) firstMatch = match;
    lastMatch = match;
    candidateIndex = match + 1;
  }

  const spread = lastMatch - firstMatch + 1;
  return 400 - spread - firstMatch;
}

function itemScore(item: CommandPaletteItem, query: string): number | null {
  const fields = [item.label, item.description ?? "", ...(item.keywords ?? [])];
  let best: number | null = null;
  for (const field of fields) {
    const score = fuzzyScore(field, query);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

export function groupCommandPaletteItems<T extends CommandPaletteItem>(
  items: readonly T[],
  query: string,
): CommandPaletteGroup<T>[] {
  const ranked = items
    .map((item, index) => ({ item, index, score: itemScore(item, query) }))
    .filter(
      (entry): entry is { item: T; index: number; score: number } =>
        entry.score !== null,
    )
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return GROUPS.map((group) => ({
    ...group,
    items: ranked
      .filter(({ item }) => item.group === group.id)
      .map(({ item }) => item),
  })).filter((group) => group.items.length > 0);
}
