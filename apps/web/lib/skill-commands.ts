/**
 * Slash-command matching for the chat input (#144): typing "/" opens a
 * palette of the user's runnable skills; the query matches forgivingly so
 * first-contact attempts like "/skills developer briefing" or
 * "/run weekly status" resolve to the right skill.
 */
export interface SlashSkillCandidate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  mcpProviders: string[];
}

/** Leading tokens users naturally type that aren't part of the skill name. */
const NOISE_TOKENS = new Set(["skills", "skill", "run", "use"]);

/**
 * Words that describe the kind of output more than the skill itself. Keep
 * them when they are the whole query ("/brief" should still find briefs),
 * but drop them from multi-word queries like "/weekly brief" so the
 * distinctive token can match the intended skill.
 */
const GENERIC_INTENT_TOKENS = new Set([
  "brief",
  "briefing",
  "draft",
  "report",
  "recap",
  "summarize",
  "summary",
  "update",
]);

export function isSlashCommand(input: string): boolean {
  return input.trimStart().startsWith("/");
}

/** Strip the slash and noise tokens: "/skills developer briefing" → "developer briefing". */
export function slashQuery(input: string): string {
  const raw = input.trimStart().replace(/^\/+/, "").trim();
  const words = raw.split(/\s+/).filter(Boolean);
  while (words.length > 0 && NOISE_TOKENS.has(words[0]!.toLowerCase())) {
    words.shift();
  }
  return words.join(" ");
}

/**
 * Filter skills against a slash query. Every query word must appear in the
 * skill's name, slug, or description (case-insensitive substring). An empty
 * query matches everything. Results keep name-match-first ordering so the
 * highlighted default is the intuitive one.
 */
export function filterSkillsForCommand<T extends SlashSkillCandidate>(
  input: string,
  skills: readonly T[],
): T[] {
  const query = slashQuery(input).toLowerCase();
  if (!query) return [...skills];
  const rawWords = query.split(/\s+/).filter(Boolean);
  const specificWords = rawWords.filter((w) => !GENERIC_INTENT_TOKENS.has(w));
  const words = specificWords.length > 0 ? specificWords : rawWords;

  const scored = skills
    .map((skill) => {
      const name = skill.name.toLowerCase();
      const haystack = `${name} ${skill.slug.toLowerCase()} ${(skill.description ?? "").toLowerCase()}`;
      if (!words.every((w) => haystack.includes(w))) return null;
      const nameHit = words.every((w) => name.includes(w));
      const prefixHit = name.startsWith(words[0]!);
      return { skill, score: (nameHit ? 2 : 0) + (prefixHit ? 1 : 0) };
    })
    .filter((entry): entry is { skill: T; score: number } => entry !== null);

  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.skill);
}
