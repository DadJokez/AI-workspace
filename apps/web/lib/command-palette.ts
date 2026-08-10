import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";

export type CommandPaletteGroupId =
  | "chats"
  | "files"
  | "vault"
  | "skills"
  | "apps"
  | "tools"
  | "review"
  | "admin"
  | "actions";

export type CommandPaletteReadinessState =
  | "ready"
  | "connection_required"
  | "approval_required"
  | "reconnect_required"
  | "policy_blocked"
  | "review_required"
  | "unavailable";

export interface CommandPaletteReadiness {
  state: CommandPaletteReadinessState;
  label: string;
  detail?: string;
}

export type CommandPaletteServerCommand =
  | { type: "thread"; threadId: string; title: string }
  | {
      type: "artifact";
      artifact: WorkspaceArtifactSummary;
      threadTitle?: string;
    }
  | {
      type: "settings";
      section: "memory" | "integrations";
      focusId?: string;
    }
  | { type: "run-skill"; skillId: string; skillName: string }
  | { type: "route"; href: string };

export interface CommandPaletteItem {
  id: string;
  group: CommandPaletteGroupId;
  label: string;
  description?: string | null;
  keywords?: readonly string[];
  /** Small deterministic boost for current-context and recent resources. */
  priority?: number;
  readiness?: CommandPaletteReadiness;
}

export interface CommandPaletteServerItem extends CommandPaletteItem {
  command: CommandPaletteServerCommand;
}

export interface CommandPaletteApiResponse {
  items: CommandPaletteServerItem[];
  isAdmin: boolean;
  partialSections: CommandPaletteGroupId[];
  durationMs: number;
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
  { id: "files", label: "Files" },
  { id: "vault", label: "Memory" },
  { id: "skills", label: "Skills" },
  { id: "apps", label: "Apps" },
  { id: "tools", label: "Tools" },
  { id: "review", label: "Review" },
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
  if (best === null) return null;
  // Keep match quality dominant: an exact match (1000) must always outrank a
  // prefix (900), even when the latter is the current thread.
  const priority = Math.max(-40, Math.min(40, item.priority ?? 0));
  return best + priority;
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

  const groups = GROUPS.map((group, groupIndex) => {
    const entries = ranked.filter(({ item }) => item.group === group.id);
    return {
      ...group,
      groupIndex,
      score: entries[0]?.score ?? Number.NEGATIVE_INFINITY,
      items: entries.map(({ item }) => item),
    };
  }).filter((group) => group.items.length > 0);

  // With a query, order groups by their strongest result so an exact match in
  // Files or Tools is not hidden below a loose match in Chats. With no query,
  // retain the familiar product grouping from #520.
  if (normalize(query)) {
    groups.sort(
      (left, right) =>
        right.score - left.score || left.groupIndex - right.groupIndex,
    );
  }

  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items,
  }));
}
